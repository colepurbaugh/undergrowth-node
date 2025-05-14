const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const raspi = require('raspi');
const { I2C } = require('raspi-i2c');
const AHT10 = require('./public/assets/js/aht10');
const SystemInfo = require('./systemInfo');
const Gpio = require('pigpio').Gpio;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const mqtt = require('mqtt');
const os = require('os');
const { Bonjour } = require('bonjour-service');

console.log('\n============ Startup Initiated ============');

// Define the port constant
const PORT = 80;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Initialize system info
const systemInfo = new SystemInfo();

// MQTT state variables
let mqttClient = null;
let brokerDiscoveryActive = false;
let brokerRetryTimeout = null;
let mqttState = {
    brokerAddress: null,
    brokerPort: null,
    connectionStatus: 'disconnected',
    lastConnectionTime: null,
    connectionDuration: 0,
    reconnectionAttempts: 0,
    lastMessageTime: null,
    topicsSubscribed: []
};

// Function to set node ID based on MAC address
function setNodeId() {
    const networkInfo = SystemInfo.getNetworkInfo();
    if (networkInfo.macAddress && networkInfo.macAddress !== 'Not available') {
        const lastThreeBytes = networkInfo.macAddress.split(':').slice(-3).join('').toUpperCase();
        return `node-${lastThreeBytes}`;
    }
    // Fallback to temporary ID if MAC address not available
    const tempId = Math.random().toString(16).slice(2, 5).toUpperCase();
    return `node-TMP${tempId}`;
}

// Set node ID
const nodeId = setNodeId();

// Create a single I2C instance
const i2c = new I2C();

// Store sensor instances
const sensors = {};

// Function to initialize a sensor based on its type
function createSensor(address, type) {
    // Convert string address to number if needed
    const addrHex = address.startsWith('0x') ? parseInt(address, 16) : parseInt(address);
    
    // Create the appropriate sensor based on type
    switch(type) {
        case 'AHT10':
            return new AHT10(i2c, addrHex);
        case 'AHT20':
            return new AHT10(i2c, addrHex); // Using AHT10 driver for now, can be extended
        // Add other sensor types here as needed
        default:
            console.warn(`Unknown sensor type: ${type}`);
            return null;
    }
}

// Function to load configured sensors from database
function loadSensors() {
    return new Promise((resolve, reject) => {
        configDb.all('SELECT * FROM sensor_config WHERE enabled = 1', [], async (err, rows) => {
            if (err) {
                console.error('Error loading sensor configurations:', err);
                reject(err);
                return;
            }
            
            console.log(`Found ${rows.length} enabled sensors in database`);
            
            // Clear existing sensors
            Object.keys(sensors).forEach(key => {
                delete sensors[key];
            });
            
            // Create sensor instances for each enabled sensor
            for (const row of rows) {
                try {
                    // If address contains type info (e.g. 0x38-AHT10), parse it
                    let address = row.address;
                    let type = row.type;
                    
                    if (address.includes('-')) {
                        const parts = address.split('-');
                        address = parts[0];
                        type = parts[1] || type;
                    }
                    
                    const sensor = createSensor(address, type);
                    if (sensor) {
                        // Store with the full address as key
                        sensors[row.address] = {
                            instance: sensor,
                            config: row,
                            lastReading: null
                        };
                        console.log(`Initialized sensor ${type} at ${address}`);
                    }
                } catch (error) {
                    console.error(`Error initializing sensor ${row.type} at ${row.address}:`, error);
                }
            }
            
            resolve(sensors);
        });
    });
}

// Create two sensor instances with different addresses, sharing the same I2C instance
// These are kept for backward compatibility
const sensor1 = new AHT10(i2c, 0x38); // First sensor
const sensor2 = new AHT10(i2c, 0x39); // Second sensor

// PWM GPIO pins (hardware PWM available on GPIO12, GPIO13, GPIO18, GPIO19)
const pwmPins = {
    12: null,
    13: null,
    18: null,
    19: null
};

let pwmEnabled = false;

// Initialize PWM pins
function initPwmPins() {
    try {
        Object.keys(pwmPins).forEach(pin => {
            pwmPins[pin] = new Gpio(parseInt(pin), {mode: Gpio.OUTPUT});
            // Set initial PWM frequency to 800Hz (you can adjust this)
            pwmPins[pin].pwmFrequency(800);
            // Set initial duty cycle to 0
            pwmPins[pin].pwmWrite(0);
        });
        pwmEnabled = true;
        console.log('PWM pins initialized successfully');
    } catch (error) {
        console.warn('PWM initialization failed:', error.message);
        console.warn('PWM functionality will be disabled');
        pwmEnabled = false;
    }
}

// Function to load PWM states from database
function loadPwmStates(db) {
    db.all('SELECT pin, value, enabled FROM pwm_states', [], (err, rows) => {
        if (err) {
            console.error('Error loading PWM states:', err);
            return;
        }
        
        // Initialize PWM states from database
        rows.forEach(row => {
            const pin = row.pin;
            if (pwmPins[pin]) {
                pwmPins[pin].value = row.value;
                pwmPins[pin].enabled = row.enabled;
                pwmPins[pin].normal_enable = row.enabled;
                console.log(`Loaded PWM state for GPIO${pin}: value=${row.value}, enabled=${row.enabled}`);
            }
        });
    });
}

// Serve static files from public directory
app.use(express.static('public'));
app.use(express.json()); // Add JSON body parser

// Serve node-index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'node-index.html'));
});

// Route for PWM interface
app.get('/pwm', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pwm.html'));
});

// Route for graph interface
app.get('/graph', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'graph.html'));
});

// Route for schedule interface
app.get('/schedule', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'schedule.html'));
});

// API Endpoint to get sensor configurations
app.get('/api/sensors', (req, res) => {
    configDb.all('SELECT * FROM sensor_config ORDER BY created_at ASC', [], (err, rows) => {
        if (err) {
            console.error('Error fetching sensors:', err);
            return res.status(500).json({ error: 'Failed to fetch sensors' });
        }
        res.json(rows);
    });
});

// API Endpoint to add a new sensor
app.post('/api/sensors', (req, res) => {
    const { address, type, name } = req.body;
    
    if (!address || !type) {
        return res.status(400).json({ error: 'Address and type are required' });
    }
    
    configDb.run(
        'INSERT INTO sensor_config (address, type, name) VALUES (?, ?, ?)',
        [address, type, name || null],
        function(err) {
            if (err) {
                console.error('Error adding sensor:', err);
                return res.status(500).json({ error: 'Failed to add sensor' });
            }
            
            const id = this.lastID;
            res.status(201).json({ 
                id, 
                address, 
                type, 
                name, 
                enabled: 1,
                calibration_offset: 0.0,
                calibration_scale: 1.0
            });
        }
    );
});

// API Endpoint to update a sensor
app.put('/api/sensors/:id', (req, res) => {
    const { id } = req.params;
    const { name, enabled, calibration_offset, calibration_scale } = req.body;
    
    const updateFields = [];
    const params = [];
    
    if (name !== undefined) {
        updateFields.push('name = ?');
        params.push(name);
    }
    
    if (enabled !== undefined) {
        updateFields.push('enabled = ?');
        params.push(enabled ? 1 : 0);
    }
    
    if (calibration_offset !== undefined) {
        updateFields.push('calibration_offset = ?');
        params.push(calibration_offset);
    }
    
    if (calibration_scale !== undefined) {
        updateFields.push('calibration_scale = ?');
        params.push(calibration_scale);
    }
    
    if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
    }
    
    updateFields.push('last_updated = CURRENT_TIMESTAMP');
    params.push(id);
    
    const query = `UPDATE sensor_config SET ${updateFields.join(', ')} WHERE id = ?`;
    
    configDb.run(query, params, function(err) {
        if (err) {
            console.error('Error updating sensor:', err);
            return res.status(500).json({ error: 'Failed to update sensor' });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Sensor not found' });
        }
        
        // Get the updated sensor
        configDb.get('SELECT * FROM sensor_config WHERE id = ?', [id], (err, row) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to fetch updated sensor' });
            }
            res.json(row);
        });
    });
});

// API Endpoint to delete a sensor
app.delete('/api/sensors/:id', (req, res) => {
    const { id } = req.params;
    
    configDb.run('DELETE FROM sensor_config WHERE id = ?', [id], function(err) {
        if (err) {
            console.error('Error deleting sensor:', err);
            return res.status(500).json({ error: 'Failed to delete sensor' });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Sensor not found' });
        }
        
        res.status(204).send();
    });
});

// Flag to control database logging
let shouldLogDatabase = false;

// Initialize databases
const configDb = new sqlite3.Database('./database/ug-config.db', (err) => {
    if (err) {
        console.error('Error opening config database:', err);
        process.exit(1);
    }
    if (shouldLogDatabase) {
        console.log('Connected to config database');
    }
    
    // Create tables if they don't exist
    configDb.serialize(() => {
        // Create events table
        configDb.run(`CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            gpio INTEGER NOT NULL,
            time TEXT NOT NULL,
            pwm_value INTEGER NOT NULL,
            enabled INTEGER DEFAULT 1
        )`);
        
        // Create pwm_states table
        configDb.run(`CREATE TABLE IF NOT EXISTS pwm_states (
            pin INTEGER PRIMARY KEY,
            value INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 0,
            last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Create auto_pwm_states table
        configDb.run(`CREATE TABLE IF NOT EXISTS auto_pwm_states (
            pin INTEGER PRIMARY KEY,
            value INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 0,
            last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Create sensor_config table for storing sensor configurations
        configDb.run(`CREATE TABLE IF NOT EXISTS sensor_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            address TEXT NOT NULL,
            type TEXT NOT NULL,
            name TEXT,
            enabled INTEGER DEFAULT 1,
            calibration_offset REAL DEFAULT 0.0,
            calibration_scale REAL DEFAULT 1.0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(address)
        )`);
        
        // Create safety_state table
        configDb.run(`CREATE TABLE IF NOT EXISTS safety_state (
            key TEXT PRIMARY KEY,
            value INTEGER DEFAULT 0
        )`);
        
        // Create system_state table
        configDb.run(`CREATE TABLE IF NOT EXISTS system_state (
            key TEXT PRIMARY KEY,
            value INTEGER DEFAULT 1
        )`);
        
        // Create timezone table
        configDb.run(`CREATE TABLE IF NOT EXISTS timezone (
            key TEXT PRIMARY KEY,
            value TEXT DEFAULT 'America/Los_Angeles'
        )`);
        
        // Create sequence_tracker table
        configDb.run(`CREATE TABLE IF NOT EXISTS sequence_tracker (
            key TEXT PRIMARY KEY,
            value INTEGER DEFAULT 0
        )`);
        
        // Create server_sync table to track server sync status
        configDb.run(`CREATE TABLE IF NOT EXISTS server_sync (
            server_id TEXT PRIMARY KEY,
            last_sync_time DATETIME,
            last_sequence INTEGER DEFAULT 0,
            last_seen DATETIME
        )`);
        
        // Initialize sequence counter if not exists
        configDb.run('INSERT OR IGNORE INTO sequence_tracker (key, value) VALUES (?, ?)', ['last_sequence', 0]);
        
        // Initialize timezone
        configDb.run('INSERT OR IGNORE INTO timezone (key, value) VALUES (?, ?)', ['timezone', 'America/Los_Angeles']);
        
        // Initialize PWM states in database if they don't exist
        const pins = [12, 13, 18, 19];
        pins.forEach(pin => {
            configDb.run('INSERT OR IGNORE INTO pwm_states (pin, value, enabled) VALUES (?, 0, 0)', [pin]);
            configDb.run('INSERT OR IGNORE INTO auto_pwm_states (pin, value, enabled) VALUES (?, 0, 0)', [pin]);
        });
        
        // Initialize safety states
        configDb.run('INSERT OR IGNORE INTO safety_state (key, value) VALUES (?, 0)', ['emergency_stop']);
        configDb.run('INSERT OR IGNORE INTO safety_state (key, value) VALUES (?, 1)', ['normal_enable']);
        
        // Initialize system state
        configDb.run('INSERT OR IGNORE INTO system_state (key, value) VALUES (?, 1)', ['mode']);
        
        // Load PWM states from database
        loadPwmStates(configDb);
    });
});

const dataDb = new sqlite3.Database('./database/ug-data.db', (err) => {
    if (err) {
        console.error('Error opening data database:', err);
        process.exit(1);
    }
    if (shouldLogDatabase) {
        console.log('Connected to data database');
    }
    
    // Create tables if they don't exist
    dataDb.serialize(() => {
        // Create sensor_readings table with sequence_id
        dataDb.run(`CREATE TABLE IF NOT EXISTS sensor_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            device_id TEXT,
            type TEXT,
            value REAL,
            sequence_id INTEGER
        )`);
        
        // Create index on sequence_id for fast lookups
        dataDb.run(`CREATE INDEX IF NOT EXISTS idx_sequence_id ON sensor_readings(sequence_id)`);
    });
});

// Function to get next sequence ID
function getNextSequenceId() {
    return new Promise((resolve, reject) => {
        configDb.get('SELECT value FROM sequence_tracker WHERE key = ?', ['last_sequence'], (err, row) => {
            if (err) {
                console.error('Error getting last sequence ID:', err);
                reject(err);
                return;
            }
            
            const currentValue = row ? row.value : 0;
            const nextValue = currentValue + 1;
            
            configDb.run('UPDATE sequence_tracker SET value = ? WHERE key = ?', [nextValue, 'last_sequence'], (err) => {
                if (err) {
                    console.error('Error updating sequence ID:', err);
                    reject(err);
                    return;
                }
                
                resolve(nextValue);
            });
        });
    });
}

// Function to get sequence range
function getSequenceRange() {
    return new Promise((resolve, reject) => {
        dataDb.get('SELECT MIN(sequence_id) as min_seq, MAX(sequence_id) as max_seq, COUNT(*) as count FROM sensor_readings', [], (err, row) => {
            if (err) {
                console.error('Error getting sequence range:', err);
                reject(err);
                return;
            }
            
            resolve({
                minSequence: row.min_seq || 0,
                maxSequence: row.max_seq || 0,
                count: row.count || 0
            });
        });
    });
}

// Function to get data for a specific sequence range
function getDataBySequenceRange(startSequence, endSequence, limit = 1000) {
    return new Promise((resolve, reject) => {
        dataDb.all(
            `SELECT id, timestamp, device_id, type, value, sequence_id 
             FROM sensor_readings 
             WHERE sequence_id >= ? AND sequence_id <= ? 
             ORDER BY sequence_id ASC
             LIMIT ?`,
            [startSequence, endSequence, limit],
            (err, rows) => {
                if (err) {
                    console.error('Error getting data by sequence range:', err);
                    reject(err);
                    return;
                }
                
                resolve(rows);
            }
        );
    });
}

// Initialize sensors and start reading
async function initAndRead() {
    try {
        // Initialize legacy sensors (for backward compatibility)
        const [init1, init2] = await Promise.all([
            sensor1.initSensor(),
            sensor2.initSensor()
        ]);

        if (!init1 || !init2) {
            console.error('Failed to initialize one or both legacy sensors');
        }

        // Load configured sensors from database
        await loadSensors();
        
        // Initialize all configured sensors
        for (const key of Object.keys(sensors)) {
            const sensorObj = sensors[key];
            try {
                const initialized = await sensorObj.instance.initSensor();
                if (!initialized) {
                    console.error(`Failed to initialize sensor ${sensorObj.config.type} at address ${sensorObj.config.address}`);
                }
            } catch (err) {
                console.error(`Error initializing sensor ${sensorObj.config.type} at address ${sensorObj.config.address}:`, err);
            }
        }
        
        // Read sensors every 10 seconds instead of every second
        setInterval(async () => {
            try {
                // For backward compatibility, always read the legacy sensors
                const [data1, data2, systemInfo] = await Promise.all([
                    sensor1.readTemperatureAndHumidity(),
                    sensor2.readTemperatureAndHumidity(),
                    SystemInfo.getSystemInfo()
                ]);

                // Read data from all configured sensors
                const sensorReadings = {};
                const sensorReadPromises = [];
                
                // Collect all reading promises
                for (const key of Object.keys(sensors)) {
                    const sensorObj = sensors[key];
                    sensorReadPromises.push(
                        sensorObj.instance.readTemperatureAndHumidity()
                            .then(data => {
                                if (data) {
                                    sensorReadings[key] = data;
                                    sensors[key].lastReading = data;
                                }
                                return data;
                            })
                            .catch(err => {
                                console.error(`Error reading sensor ${sensorObj.config.type} at address ${sensorObj.config.address}:`, err);
                                return null;
                            })
                    );
                }
                
                // Wait for all sensors to be read
                await Promise.all(sensorReadPromises);

                // Process legacy sensor data (for backward compatibility)
                if (data1 && data2) {
                    // Get next sequence IDs for the readings
                    try {
                        const seqId1 = await getNextSequenceId();
                        const seqId2 = await getNextSequenceId();
                        const seqId3 = await getNextSequenceId();
                        const seqId4 = await getNextSequenceId();
                        
                        // Store readings in data database
                        const timestamp = new Date().toISOString();
                        
                        // Store temperature readings
                        if (dataDb) {
                            dataDb.run(
                                'INSERT INTO sensor_readings (timestamp, device_id, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',
                                [timestamp, 'sensor1', 'temperature', data1.temperature, seqId1]
                            );
                            dataDb.run(
                                'INSERT INTO sensor_readings (timestamp, device_id, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',
                                [timestamp, 'sensor2', 'temperature', data2.temperature, seqId2]
                            );
                            
                            // Store humidity readings
                            dataDb.run(
                                'INSERT INTO sensor_readings (timestamp, device_id, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',
                                [timestamp, 'sensor1', 'humidity', data1.humidity, seqId3]
                            );
                            dataDb.run(
                                'INSERT INTO sensor_readings (timestamp, device_id, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',
                                [timestamp, 'sensor2', 'humidity', data2.humidity, seqId4]
                            );
                        }
                    } catch (seqErr) {
                        console.error('Error getting sequence IDs for legacy sensors:', seqErr);
                    }
                }
                
                // Process readings from configured sensors
                for (const [address, data] of Object.entries(sensorReadings)) {
                    try {
                        const sensorConfig = sensors[address].config;
                        const sensorId = `sensor_${sensorConfig.id}`;
                        
                        // Get sequence IDs
                        const tempSeqId = await getNextSequenceId();
                        const humiditySeqId = await getNextSequenceId();
                        
                        const timestamp = new Date().toISOString();
                        
                        // Store readings in database
                        if (dataDb) {
                            // Apply calibration if configured
                            const tempValue = (data.temperature * (sensorConfig.calibration_scale || 1)) + 
                                             (sensorConfig.calibration_offset || 0);
                            
                            const humidityValue = data.humidity;
                            
                            // Store temperature reading
                            dataDb.run(
                                'INSERT INTO sensor_readings (timestamp, device_id, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',
                                [timestamp, sensorId, 'temperature', tempValue, tempSeqId]
                            );
                            
                            // Store humidity reading
                            dataDb.run(
                                'INSERT INTO sensor_readings (timestamp, device_id, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',
                                [timestamp, sensorId, 'humidity', humidityValue, humiditySeqId]
                            );
                        }
                    } catch (seqErr) {
                        console.error(`Error processing readings for sensor ${address}:`, seqErr);
                    }
                }

                // Get database timezone
                if (configDb) {
                    configDb.get('SELECT value FROM timezone WHERE key = ?', ['timezone'], (err, row) => {
                        const databaseTimezone = err || !row ? 'America/Los_Angeles' : row.value;
                        
                        // Prepare data to send to clients
                        const sensorDataForClients = {};
                        
                        // Add legacy sensors
                        if (data1) {
                            sensorDataForClients.sensor1 = {
                                ...data1,
                                address: '0x38',
                                temperature: `${data1.temperature.toFixed(1)}°F (${((data1.temperature - 32) * 5/9).toFixed(1)}°C)`
                            };
                        }
                        
                        if (data2) {
                            sensorDataForClients.sensor2 = {
                                ...data2,
                                address: '0x39',
                                temperature: `${data2.temperature.toFixed(1)}°F (${((data2.temperature - 32) * 5/9).toFixed(1)}°C)`
                            };
                        }
                        
                        // Add all configured sensors
                        for (const [address, sensorObj] of Object.entries(sensors)) {
                            const reading = sensorObj.lastReading;
                            if (reading) {
                                // Generate a sensor ID
                                const sensorId = `sensor_${sensorObj.config.id}`;
                                
                                // Apply calibration if configured
                                const tempValue = (reading.temperature * (sensorObj.config.calibration_scale || 1)) + 
                                                 (sensorObj.config.calibration_offset || 0);
                                
                                sensorDataForClients[sensorId] = {
                                    ...reading,
                                    address: address,
                                    temperature: `${tempValue.toFixed(1)}°F (${((tempValue - 32) * 5/9).toFixed(1)}°C)`,
                                    raw_temperature: tempValue,
                                    config: sensorObj.config
                                };
                            }
                        }
                        
                        // Send all sensor data with both system and database timezone
                        if (io) {
                            io.emit('sensorData', {
                                system: systemInfo.system,
                                databaseTimezone,
                                ...sensorDataForClients
                            });
                        }
                        
                        // Publish sensor data to MQTT broker
                        publishSensorData(data1, data2, sensorReadings);
                    });
                }
            } catch (error) {
                console.error('Error reading sensors:', error);
            }
        }, 10000); // Changed from 1000 (1 second) to 10000 (10 seconds)
    } catch (error) {
        console.error('Error initializing sensors:', error);
    }
}

// Publish sensor data to MQTT
function publishSensorData(sensor1Data, sensor2Data, configuredSensorData = {}) {
    if (!mqttClient || !mqttClient.connected) return;
    
    const sensors = {};
    
    // Add legacy sensors for backward compatibility
    if (sensor1Data) {
        sensors.sensor1 = {
            address: '0x38',
            temperature: sensor1Data.temperature,
            humidity: sensor1Data.humidity
        };
    }
    
    if (sensor2Data) {
        sensors.sensor2 = {
            address: '0x39',
            temperature: sensor2Data.temperature,
            humidity: sensor2Data.humidity
        };
    }
    
    // Add configured sensors
    for (const [address, sensorObj] of Object.entries(sensors)) {
        if (configuredSensorData[address]) {
            const reading = configuredSensorData[address];
            const config = sensorObj.config || {};
            
            // Apply calibration if configured
            const tempValue = (reading.temperature * (config.calibration_scale || 1)) + 
                             (config.calibration_offset || 0);
            
            sensors[`sensor_${config.id || address}`] = {
                id: config.id,
                address: address,
                type: config.type || 'unknown',
                name: config.name,
                temperature: tempValue,
                humidity: reading.humidity
            };
        }
    }
    
    const data = {
        nodeId,
        timestamp: new Date().toISOString(),
        sensors
    };
    
    mqttClient.publish(`undergrowth/nodes/${nodeId}/sensors`, JSON.stringify(data), { qos: 1 });
}

// Function to broadcast safety state to all clients
function broadcastSafetyState() {
    configDb.all('SELECT key, value FROM safety_state', [], (err, rows) => {
        if (err) {
            console.error('Error fetching safety state for broadcast:', err);
            return;
        }
        
        const safetyStates = {};
        rows.forEach(row => {
            safetyStates[row.key] = row.value === 1;
        });
        
        io.emit('safetyStateUpdate', safetyStates);
    });
}

// Function to broadcast PWM states to all clients
function broadcastPWMState() {
    console.log('Server: Broadcasting PWM state...');
    
    // Get both manual and auto PWM states
    Promise.all([
        new Promise((resolve, reject) => {
            configDb.all('SELECT pin, value, enabled FROM pwm_states', [], (err, rows) => {
                if (err) {
                    console.error('Server: Error fetching manual PWM states:', err);
                    resolve({});
                } else {
                    const pwmStates = {};
                    rows.forEach(row => {
                        pwmStates[row.pin] = {
                            value: row.value,
                            enabled: row.enabled === 1
                        };
                    });
                    resolve(pwmStates);
                }
            });
        }),
        new Promise((resolve, reject) => {
            configDb.all('SELECT pin, value, enabled FROM auto_pwm_states', [], (err, rows) => {
                if (err) {
                    console.error('Server: Error fetching auto PWM states:', err);
                    resolve({});
                } else {
                    const autoPwmStates = {};
                    rows.forEach(row => {
                        autoPwmStates[row.pin] = {
                            value: row.value,
                            enabled: row.enabled === 1
                        };
                    });
                    resolve(autoPwmStates);
                }
            });
        }),
        new Promise((resolve, reject) => {
            configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                if (err) {
                    console.error('Server: Error getting mode:', err);
                    resolve(1); // Default to manual mode
                } else {
                    resolve(row ? row.value : 1);
                }
            });
        })
    ]).then(([manualStates, autoStates, mode]) => {
        // Send both states to clients, plus current mode
        const currentStates = mode === 0 ? autoStates : manualStates;
        
        console.log('Server: Broadcasting PWM states:', {
            mode,
            current: currentStates,
            manual: manualStates,
            auto: autoStates
        });
        
        io.emit('pwmStateUpdate', {
            mode,
            current: currentStates,
            manual: manualStates,
            auto: autoStates
        });
    }).catch(err => {
        console.error('Server: Error in broadcastPWMState:', err);
    });
}

// Update emergency stop function
async function emergencyStop() {
    return new Promise((resolve) => {
        configDb.run('UPDATE safety_state SET value = 1 WHERE key = ?', ['emergency_stop'], resolve);
    });
}

// Update clear emergency stop function
async function clearEmergencyStop() {
    return new Promise((resolve) => {
        configDb.run('UPDATE safety_state SET value = 0 WHERE key = ?', ['emergency_stop'], resolve);
    });
}

// Update togglePWM function
async function togglePWM(pin, enabled) {
    return new Promise((resolve) => {
        // Get current value
        configDb.get('SELECT value FROM pwm_states WHERE pin = ?', [pin], (err, row) => {
            if (err) {
                console.error('Error getting PWM value:', err);
                resolve();
                return;
            }
            
            const value = row ? row.value : 0;
            
            // Update database
            configDb.run('UPDATE pwm_states SET enabled = ? WHERE pin = ?', [enabled ? 1 : 0, pin], (err) => {
                if (err) {
                    console.error('Error updating PWM state:', err);
                }
                
                // Update hardware only if we're in manual mode - we don't change active outputs in auto mode
                configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                    const mode = err || !row ? 1 : row.value; // Default to manual mode
                    
                    // Only update hardware if we're in manual mode
                    if (mode === 1 && pwmEnabled && pwmPins[pin]) {
                        if (enabled) {
                            const pwmValue = Math.floor((value / 1023) * 255);
                            pwmPins[pin].pwmWrite(pwmValue);
                            pwmPins[pin]._pwmValue = value;
                        } else {
                            pwmPins[pin].pwmWrite(0);
                            pwmPins[pin]._pwmValue = 0;
                        }
                    }
                    
                    // Broadcast the new state to all clients
                    broadcastPWMState();
                    
                    resolve();
                });
            });
        });
    });
}

// ======================================
// MQTT BROKER FUNCTIONS
// ======================================
async function discoverBroker() {
    if (brokerDiscoveryActive) {
        return Promise.reject(new Error('Broker discovery already active'));
    }
    
    brokerDiscoveryActive = true;
    return new Promise((resolve, reject) => {
        const bonjour = new Bonjour();
        const browser = bonjour.find({ type: 'mqtt' });
        
        browser.on('up', (service) => {
            mqttState.brokerAddress = service.addresses[0];
            mqttState.brokerPort = service.port;
            browser.stop();
            bonjour.destroy();
            brokerDiscoveryActive = false;
            resolve({ address: mqttState.brokerAddress, port: mqttState.brokerPort });
        });

        browser.on('down', (service) => {
            console.log('MQTT broker went down:', service);
        });

        // Timeout after 10 seconds
        setTimeout(() => {
            browser.stop();
            bonjour.destroy();
            brokerDiscoveryActive = false;
            reject(new Error('MQTT broker discovery timeout'));
        }, 10000);
    });
}

function connectToBroker(nodeId) {
    if (!mqttState.brokerAddress || !mqttState.brokerPort) {
        throw new Error('Broker address not discovered');
    }

    const brokerUrl = `mqtt://${mqttState.brokerAddress}:${mqttState.brokerPort}`;
    console.log('Connecting to MQTT broker at:', brokerUrl);

    const client = mqtt.connect(brokerUrl, {
        clientId: nodeId,
        clean: true,
        reconnectPeriod: 5000
    });

    client.on('connect', () => {
        console.log('Connected to MQTT broker');
        mqttState.connectionStatus = 'connected';
        mqttState.lastConnectionTime = new Date();
        mqttState.reconnectionAttempts = 0;
    });

    client.on('disconnect', () => {
        console.log('Disconnected from MQTT broker');
        mqttState.connectionStatus = 'disconnected';
    });

    client.on('reconnect', () => {
        console.log('Reconnecting to MQTT broker...');
        mqttState.reconnectionAttempts++;
    });

    client.on('error', (err) => {
        console.error('MQTT error:', err);
    });

    // Update last message time on any message
    client.on('message', () => {
        updateLastMessageTime();
    });

    return client;
}

function getBrokerInfo() {
    // Calculate current connection duration if connected
    if (mqttState.connectionStatus === 'connected' && mqttState.lastConnectionTime) {
        mqttState.connectionDuration = Date.now() - mqttState.lastConnectionTime;
    }

    // Format connection duration
    let durationStr = 'Not connected';
    if (mqttState.connectionDuration) {
        const hours = Math.floor(mqttState.connectionDuration / (1000 * 60 * 60));
        const minutes = Math.floor((mqttState.connectionDuration % (1000 * 60 * 60)) / (1000 * 60));
        if (hours > 0) {
            durationStr = `${hours}h ${minutes}m`;
        } else {
            durationStr = `${minutes}m`;
        }
    }

    return {
        status: mqttState.connectionStatus,
        address: mqttState.brokerAddress,
        port: mqttState.brokerPort,
        lastConnection: mqttState.lastConnectionTime,
        connectionDuration: durationStr,
        reconnectionAttempts: mqttState.reconnectionAttempts,
        lastMessage: mqttState.lastMessageTime,
        topicsSubscribed: mqttState.topicsSubscribed
    };
}

function updateLastMessageTime() {
    mqttState.lastMessageTime = new Date();
}

function addSubscribedTopic(topic) {
    if (!mqttState.topicsSubscribed.includes(topic)) {
        mqttState.topicsSubscribed.push(topic);
    }
}

function removeSubscribedTopic(topic) {
    mqttState.topicsSubscribed = mqttState.topicsSubscribed.filter(t => t !== topic);
}

// Function to emit broker information
function emitBrokerInfo() {
    if (!io) return;
    
    const info = getBrokerInfo();
    io.emit('brokerInfo', {
        connected: mqttClient ? mqttClient.connected : false,
        address: info.address,
        port: info.port,
        lastConnection: info.lastConnection,
        connectionDuration: info.connectionDuration,
        reconnectionAttempts: info.reconnectionAttempts,
        lastMessage: info.lastMessage,
        subscribedTopics: info.topicsSubscribed
    });
}

// Update broker info every 5 seconds
setInterval(emitBrokerInfo, 5000);

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected');

    // Emit initial broker info
    emitBrokerInfo();

    // Handle timezone get request
    socket.on('getTimezone', () => {
        configDb.get('SELECT value FROM timezone WHERE key = ?', ['timezone'], (err, row) => {
            if (err) {
                console.error('Error getting timezone:', err);
                return;
            }
            const timezone = row ? row.value : 'America/Los_Angeles';
            socket.emit('timezoneUpdate', { timezone });
        });
    });

    // Handle timezone set request
    socket.on('setTimezone', (data) => {
        const { timezone } = data;
        configDb.run('UPDATE timezone SET value = ? WHERE key = ?', [timezone, 'timezone'], (err) => {
            if (err) {
                console.error('Error setting timezone:', err);
                return;
            }
            // Broadcast the new timezone to all clients
            io.emit('timezoneUpdate', { timezone });
        });
    });

    // Handle initial state request
    socket.on('getInitialState', async () => {
        try {
            //console.log('Handling getInitialState request');
            
            // Get system info including system timezone - forced fresh data
            const systemInfo = await SystemInfo.getSystemInfo();
            
            // Get mode from database
            const mode = await new Promise((resolve, reject) => {
                configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.value : 1);
                });
            });
            //console.log('Current mode:', mode);
            
            // Get database timezone
            const databaseTimezone = await new Promise((resolve, reject) => {
                configDb.get('SELECT value FROM timezone WHERE key = ?', ['timezone'], (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.value : 'America/Los_Angeles');
                });
            });
            //console.log('Database timezone:', databaseTimezone);
            //console.log('System timezone:', systemInfo.system.systemTimezone);

            const events = await new Promise((resolve, reject) => {
                configDb.all('SELECT * FROM events ORDER BY time', [], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });

            const safetyStates = await new Promise((resolve, reject) => {
                configDb.all('SELECT key, value FROM safety_state', [], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows.reduce((acc, row) => {
                        acc[row.key] = row.value;
                        return acc;
                    }, {}));
                });
            });
            //console.log('Safety states:', safetyStates);

            // Get manual PWM states
            const manualPwmStates = await new Promise((resolve, reject) => {
                configDb.all('SELECT pin, value, enabled FROM pwm_states', [], (err, rows) => {
                    if (err) reject(err);
                    else {
                        const states = {};
                        rows.forEach(row => {
                            states[row.pin] = {
                                value: row.value,
                                enabled: row.enabled === 1
                            };
                        });
                        resolve(states);
                    }
                });
            });

            // Get automatic PWM states
            const autoPwmStates = await new Promise((resolve, reject) => {
                configDb.all('SELECT pin, value, enabled FROM auto_pwm_states', [], (err, rows) => {
                    if (err) reject(err);
                    else {
                        const states = {};
                        rows.forEach(row => {
                            states[row.pin] = {
                                value: row.value,
                                enabled: row.enabled === 1
                            };
                        });
                        resolve(states);
                    }
                });
            });

            // Current PWM states based on mode
            const currentPwmStates = mode === 0 ? autoPwmStates : manualPwmStates;

            const initialState = {
                mode,
                events,
                safetyStates,
                pwmStates: {
                    current: currentPwmStates,
                    manual: manualPwmStates,
                    auto: autoPwmStates
                },
                system: systemInfo.system,
                databaseTimezone
            };
            //console.log('Sending initial state:', initialState);
            socket.emit('initialState', initialState);
        } catch (error) {
            console.error('Error getting initial state:', error);
        }
    });

    // Handle emergency stop
    socket.on('emergencyStop', async () => {
        await emergencyStop();
        broadcastSafetyState();
        io.emit('emergencyStop');
    });

    // Handle clear emergency stop
    socket.on('clearEmergencyStop', async () => {
        await clearEmergencyStop();
        broadcastSafetyState();
        io.emit('clearEmergencyStop');
    });

    // Handle mode toggle
    socket.on('toggleMode', async (data) => {
        //console.log('Server: Received mode toggle:', data);
        const { automatic } = data;
        const mode = automatic ? 0 : 1; // 0 is automatic, 1 is manual
        try {
            configDb.run('UPDATE system_state SET value = ? WHERE key = ?',
                [mode, 'mode'], (err) => {
                    if (err) {
                        console.error('Server: Error updating mode:', err);
                        socket.emit('modeError', { message: 'Failed to update mode' });
                    } else {
                        console.log('Server: Mode updated successfully to:', mode);
                        // Broadcast the new mode to all clients
                        io.emit('modeUpdate', { mode });
                    }
                });
        } catch (error) {
            console.error('Server: Error handling mode toggle:', error);
            socket.emit('modeError', { message: 'Failed to update mode' });
        }
    });

    // Handle PWM set requests
    socket.on('pwmSet', async (data) => {
        console.log('Server: Received pwmSet event:', data);
        const { pin, value } = data;
        
        try {
            // Always update the database regardless of hardware availability
            console.log('Server: Updating database with value:', { pin, value });
            configDb.run('UPDATE pwm_states SET value = ? WHERE pin = ?',
                [value, pin], (err) => {
                    if (err) {
                        console.error('Server: Error saving PWM state:', err);
                        socket.emit('pwmError', { pin, message: 'Failed to update database' });
                    } else {
                        console.log('Server: Database update successful, broadcasting state');
                        
                        // If hardware is available, update it (but only in manual mode)
                        configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                            const mode = err || !row ? 1 : row.value; // Default to manual mode
                            
                            // Only update hardware if we're in manual mode and PWM is available
                            if (mode === 1 && pwmEnabled && pwmPins[pin]) {
                                // Need to also get the enabled state
                                configDb.get('SELECT enabled FROM pwm_states WHERE pin = ?', [pin], (err, enabledRow) => {
                                    if (!err && enabledRow && enabledRow.enabled === 1) {
                                        const pwmValue = Math.floor((value / 1023) * 255);
                                        pwmPins[pin].pwmWrite(pwmValue);
                                    }
                                    // Store the value in memory for future reference
                                    if (pwmPins[pin]) {
                                        pwmPins[pin]._pwmValue = value;
                                    }
                                });
                            }
                            
                            // Broadcast the new state to all clients
                            broadcastPWMState();
                        });
                    }
                });
        } catch (error) {
            console.error(`Server: Error setting PWM value for pin ${pin}:`, error);
            socket.emit('pwmError', { pin, message: 'Failed to set PWM value' });
        }
    });

    // Handle PWM toggle requests
    socket.on('pwmToggle', async (data) => {
        await togglePWM(data.pin, data.enabled);
        broadcastPWMState();
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });

    // Handle event add
    socket.on('addEvent', async (data) => {
        try {
            // Store time in UTC format (HH:MM:SS) regardless of database or system timezone
            await new Promise((resolve, reject) => {
                configDb.run('INSERT INTO events (gpio, time, pwm_value, enabled) VALUES (?, ?, ?, ?)',
                    [data.gpio, data.time, data.pwm_value, data.enabled], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
            });
            await broadcastEvents();
            await broadcastPWMState();
        } catch (error) {
            console.error('Error adding event:', error);
        }
    });

    // Handle get events request
    socket.on('getEvents', () => {
        configDb.all('SELECT * FROM events ORDER BY time', [], (err, rows) => {
            if (err) {
                console.error('Error fetching events:', err);
                socket.emit('eventError', { message: 'Failed to fetch events' });
            } else {
                socket.emit('eventsUpdated', rows);
            }
        });
    });

    // Handle event delete
    socket.on('deleteEvent', async (data) => {
        try {
            await new Promise((resolve, reject) => {
                configDb.run('DELETE FROM events WHERE id = ?', [data.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            await broadcastEvents();
            await broadcastPWMState();
            io.emit('eventDeleted', { id: data.id });
        } catch (error) {
            console.error('Error deleting event:', error);
        }
    });

    // Handle event toggle
    socket.on('toggleEvent', (data) => {
        const { id, enabled } = data;
        
        configDb.run('UPDATE events SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id], (err) => {
            if (err) {
                console.error('Error toggling event:', err);
                socket.emit('eventError', { message: 'Failed to toggle event' });
            } else {
                broadcastEvents();
                socket.emit('eventToggled', { id, enabled });
            }
        });
    });

    // Handle normal enable toggle
    socket.on('toggleNormalEnable', async (data) => {
        await toggleNormalEnable(data.enabled);
    });

    // Handle mode set request
    socket.on('setMode', async (data) => {
        try {
            const { automatic } = data;
            const mode = automatic ? 0 : 1; // 0 is automatic, 1 is manual
            await new Promise((resolve, reject) => {
                configDb.run('UPDATE system_state SET value = ? WHERE key = ?', 
                    [mode, 'mode'], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
            });
            console.log('Server: Mode updated successfully to:', mode);
            io.emit('modeUpdate', { mode });
        } catch (error) {
            console.error('Error setting mode:', error);
        }
    });

    // Handle sensor configuration related events
    socket.on('getSensors', () => {
        configDb.all('SELECT * FROM sensor_config ORDER BY created_at ASC', [], (err, rows) => {
            if (err) {
                console.error('Error fetching sensors:', err);
                socket.emit('sensorError', { message: 'Failed to fetch sensors' });
            } else {
                socket.emit('sensorsUpdated', rows);
            }
        });
    });
    
    socket.on('addSensor', (data) => {
        const { address, type, name } = data;
        
        if (!address || !type) {
            socket.emit('sensorError', { message: 'Address and type are required' });
            return;
        }
        
        configDb.run(
            'INSERT INTO sensor_config (address, type, name) VALUES (?, ?, ?)',
            [address, type, name || null],
            function(err) {
                if (err) {
                    console.error('Error adding sensor:', err);
                    socket.emit('sensorError', { message: 'Failed to add sensor' });
                    return;
                }
                
                const id = this.lastID;
                const newSensor = { 
                    id, 
                    address, 
                    type, 
                    name, 
                    enabled: 1,
                    calibration_offset: 0.0,
                    calibration_scale: 1.0
                };
                
                socket.emit('sensorAdded', newSensor);
                socket.broadcast.emit('sensorAdded', newSensor);
            }
        );
    });
    
    socket.on('updateSensor', (data) => {
        const { id, name, enabled, calibration_offset, calibration_scale } = data;
        
        if (!id) {
            socket.emit('sensorError', { message: 'Sensor ID is required' });
            return;
        }
        
        const updateFields = [];
        const params = [];
        
        if (name !== undefined) {
            updateFields.push('name = ?');
            params.push(name);
        }
        
        if (enabled !== undefined) {
            updateFields.push('enabled = ?');
            params.push(enabled ? 1 : 0);
        }
        
        if (calibration_offset !== undefined) {
            updateFields.push('calibration_offset = ?');
            params.push(calibration_offset);
        }
        
        if (calibration_scale !== undefined) {
            updateFields.push('calibration_scale = ?');
            params.push(calibration_scale);
        }
        
        if (updateFields.length === 0) {
            socket.emit('sensorError', { message: 'No fields to update' });
            return;
        }
        
        updateFields.push('last_updated = CURRENT_TIMESTAMP');
        params.push(id);
        
        const query = `UPDATE sensor_config SET ${updateFields.join(', ')} WHERE id = ?`;
        
        configDb.run(query, params, function(err) {
            if (err) {
                console.error('Error updating sensor:', err);
                socket.emit('sensorError', { message: 'Failed to update sensor' });
                return;
            }
            
            if (this.changes === 0) {
                socket.emit('sensorError', { message: 'Sensor not found' });
                return;
            }
            
            configDb.get('SELECT * FROM sensor_config WHERE id = ?', [id], (err, row) => {
                if (err) {
                    socket.emit('sensorError', { message: 'Failed to fetch updated sensor' });
                    return;
                }
                
                socket.emit('sensorUpdated', row);
                socket.broadcast.emit('sensorUpdated', row);
            });
        });
    });
    
    socket.on('deleteSensor', (data) => {
        const { id } = data;
        
        if (!id) {
            socket.emit('sensorError', { message: 'Sensor ID is required' });
            return;
        }
        
        configDb.run('DELETE FROM sensor_config WHERE id = ?', [id], function(err) {
            if (err) {
                console.error('Error deleting sensor:', err);
                socket.emit('sensorError', { message: 'Failed to delete sensor' });
                return;
            }
            
            if (this.changes === 0) {
                socket.emit('sensorError', { message: 'Sensor not found' });
                return;
            }
            
            socket.emit('sensorDeleted', { id });
            socket.broadcast.emit('sensorDeleted', { id });
        });
    });
});

// Function to broadcast events to all connected clients
function broadcastEvents() {
    configDb.all('SELECT * FROM events ORDER BY time', [], (err, rows) => {
        if (err) {
            console.error('Error fetching events for broadcast:', err);
        } else {
            io.emit('eventsUpdated', rows);
        }
    });
}

// Binned Readings Endpoint
app.get('/api/readings/binned', async (req, res) => {
  try {
    const startDateParam = req.query.startDate;
    const hours = parseInt(req.query.hours, 10);
    const binCount = parseInt(req.query.points, 10);
    const type = req.query.type;
    const sensors = req.query.sensors ? req.query.sensors.split(',') : null;
    const showAverage = req.query.average === 'true';

    console.log(`Binned readings request: type=${type}, sensors=${req.query.sensors}, average=${showAverage}`);

    // Validate
    if (!startDateParam || !hours || !binCount || !type) {
      return res.status(400).json({
        error: 'Missing startDate, hours, points, or type'
      });
    }

    // Convert startDate to numeric epoch
    const startMs = Date.parse(startDateParam);
    if (isNaN(startMs)) {
      return res.status(400).json({ error: 'Invalid startDate format' });
    }
    const endMs = startMs + (hours * 3600 * 1000); // add X hours in ms

    // Convert to ISO for DB query
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();

    console.log(`Date range: ${startIso} to ${endIso}`);

    // Build SQL query with optional sensor filter
    let sql = `
      SELECT timestamp, device_id, value
      FROM sensor_readings
      WHERE type = ?
        AND timestamp >= ?
        AND timestamp < ?
    `;
    
    const params = [type, startIso, endIso];
    
    // Add sensor filter if provided
    if (sensors && sensors.length > 0) {
      // Map numeric IDs to possible device_id values
      const deviceIdMatches = [];
      
      // For each sensor ID, add both the ID itself and 'sensor_ID' format
      sensors.forEach(id => {
        if (id === 'legacy1') {
          deviceIdMatches.push('sensor1');
        } else if (id === 'legacy2') {
          deviceIdMatches.push('sensor2');
        } else {
          deviceIdMatches.push(`sensor_${id}`);
        }
      });
      
      if (deviceIdMatches.length > 0) {
        sql += ` AND device_id IN (${deviceIdMatches.map(() => '?').join(',')})`;
        params.push(...deviceIdMatches);
      }
    }
    
    sql += ' ORDER BY timestamp ASC';
    
    console.log('SQL Query:', sql);
    console.log('Params:', params);

    // 1) Fetch raw rows from DB
    const rawRows = await new Promise((resolve, reject) => {
      dataDb.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        console.log(`Retrieved ${rows.length} raw rows from database`);
        resolve(rows);
      });
    });

    if (!rawRows || rawRows.length === 0) {
      console.log('No data found in the specified range');
      return res.json([]); // no data in that range => return empty
    }

    // Log data summary
    const sensorCounts = {};
    rawRows.forEach(row => {
      if (!sensorCounts[row.device_id]) {
        sensorCounts[row.device_id] = 0;
      }
      sensorCounts[row.device_id]++;
    });
    console.log('Data counts by sensor:', sensorCounts);

    // If showing average across all sensors
    if (showAverage) {
      // ... existing average code ...
      // 2) Create bins
      const bins = new Array(binCount).fill(null).map(() => ({ sum: 0, count: 0 }));
      const totalMs = endMs - startMs;
      const binSizeMs = totalMs / binCount; // ms per bin

      // 3) Distribute each raw row into the correct bin
      for (const row of rawRows) {
        const tMs = Date.parse(row.timestamp);
        const offset = tMs - startMs; // ms since start
        const index = Math.floor(offset / binSizeMs);
        if (index >= 0 && index < binCount) {
          bins[index].sum += row.value;
          bins[index].count += 1;
        }
      }

      // 4) Build final output array for average
      const result = bins.map((b, i) => {
        const binStartMs = startMs + (i * binSizeMs);
        return {
          timestamp: new Date(binStartMs).toISOString(),
          value: (b.count === 0) ? null : (b.sum / b.count)
        };
      });

      console.log(`Returning ${result.length} averaged data points`);
      res.json(result);
    } else {
      // Handle multiple sensors with separate data series
      // Group by sensor first
      const sensorData = {};
      
      // For each sensor, get all of its readings
      rawRows.forEach(row => {
        if (!sensorData[row.device_id]) {
          sensorData[row.device_id] = [];
        }
        sensorData[row.device_id].push(row);
      });
      
      console.log(`Grouped data into ${Object.keys(sensorData).length} sensors`);
      
      // Process each sensor's data into bins
      const result = [];
      
      Object.entries(sensorData).forEach(([sensorId, rows]) => {
        // Create bins for this sensor
        const bins = new Array(binCount).fill(null).map(() => ({ sum: 0, count: 0 }));
        const totalMs = endMs - startMs;
        const binSizeMs = totalMs / binCount;
        
        // Distribute this sensor's data into bins
        for (const row of rows) {
          const tMs = Date.parse(row.timestamp);
          const offset = tMs - startMs;
          const index = Math.floor(offset / binSizeMs);
          if (index >= 0 && index < binCount) {
            bins[index].sum += row.value;
            bins[index].count += 1;
          }
        }
        
        // Build this sensor's result array
        bins.forEach((b, i) => {
          const binStartMs = startMs + (i * binSizeMs);
          if (b.count > 0) { // Only include bins with actual data
            result.push({
              timestamp: new Date(binStartMs).toISOString(),
              sensorId: sensorId,
              value: b.sum / b.count
            });
          }
        });
      });
      
      console.log(`Returning ${result.length} data points across all sensors`);
      res.json(result);
    }
  } catch (error) {
    console.error('Error in binned readings:', error);
    res.status(500).json({ error: 'Failed to fetch binned readings' });
  }
});

// Safety state management
function isSystemSafe() {
    return new Promise((resolve) => {
        configDb.get('SELECT value FROM safety_state WHERE key = ?', ['emergency_stop'], (err, row) => {
            if (err || !row) {
                console.error('Error checking emergency stop state:', err);
                resolve(false);
                return;
            }
            
            const isEmergencyStop = row.value === 1;
            if (isEmergencyStop) {
                resolve(false);
                return;
            }

            // If not in emergency stop, check normal enable
            configDb.get('SELECT value FROM safety_state WHERE key = ?', ['normal_enable'], (err, row) => {
                if (err || !row) {
                    console.error('Error checking normal enable state:', err);
                    resolve(false);
                    return;
                }
                resolve(row.value === 1);
            });
        });
    });
}

// Toggle normal enable
async function toggleNormalEnable(enabled) {
    if (!await isSystemSafe()) return; // Don't allow if in emergency stop

    configDb.run('UPDATE safety_state SET value = ? WHERE key = ?', [enabled ? 1 : 0, 'normal_enable']);
    io.emit('safetyStateChanged', { normalEnable: enabled });
}

// Control loop for hardware updates
async function controlLoop() {
    try {
        // Get current safety states
        const safetyStates = await new Promise((resolve, reject) => {
            configDb.all('SELECT key, value FROM safety_state', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.reduce((acc, row) => {
                    acc[row.key] = row.value;
                    return acc;
                }, {}));
            });
        });

        // Get current mode
        const mode = await new Promise((resolve, reject) => {
            configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.value : 1); // Default to manual mode
            });
        });

        // Update hardware based on mode and safety states
        if (pwmEnabled) {
            const isEmergencyStop = safetyStates.emergency_stop;
            const isNormalEnable = safetyStates.normal_enable;

            if (isEmergencyStop || !isNormalEnable) {
                // Emergency stop or normal disable - turn off all PWM outputs
                for (const pin of Object.keys(pwmPins)) {
                    pwmPins[pin].pwmWrite(0);
                }
                return;
            }

            if (mode === 0) { // Automatic mode
                // Get current time in UTC
                const now = new Date();
                const currentTime = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
                
                // Get all enabled events
                const events = await new Promise((resolve, reject) => {
                    configDb.all('SELECT * FROM events WHERE enabled = 1 ORDER BY time', [], (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    });
                });

                // Find active events for each GPIO
                const activeEvents = {};
                events.forEach(event => {
                    // Since we now store event times in UTC, parse them directly
                    const [hours, minutes, seconds] = event.time.split(':').map(Number);
                    const eventTime = hours * 3600 + minutes * 60 + seconds;
                    const gpio = event.gpio;

                    // For automatic mode, we want to use the most recent past event
                    if (!activeEvents[gpio] || 
                        (eventTime <= currentTime && eventTime > (activeEvents[gpio].time || -1)) ||
                        (eventTime > currentTime && eventTime < (activeEvents[gpio].time || Infinity))) {
                        activeEvents[gpio] = {
                            time: eventTime,
                            event: event
                        };
                    }
                });

                // Update auto_pwm_states based on active events
                for (const [gpio, activeEvent] of Object.entries(activeEvents)) {
                    if (pwmPins[gpio]) {
                        const pwmValue = Math.floor((activeEvent.event.pwm_value / 1023) * 255);
                        pwmPins[gpio].pwmWrite(pwmValue);
                        
                        // Update auto_pwm_states table
                        await new Promise((resolve, reject) => {
                            configDb.run('UPDATE auto_pwm_states SET value = ?, enabled = 1 WHERE pin = ?',
                                [activeEvent.event.pwm_value, gpio], (err) => {
                                    if (err) reject(err);
                                    else resolve();
                                });
                        });
                    }
                }

                // Turn off any GPIOs that don't have active events
                for (const pin of Object.keys(pwmPins)) {
                    if (!activeEvents[pin]) {
                        pwmPins[pin].pwmWrite(0);
                        await new Promise((resolve, reject) => {
                            configDb.run('UPDATE auto_pwm_states SET value = 0, enabled = 0 WHERE pin = ?',
                                [pin], (err) => {
                                    if (err) reject(err);
                                    else resolve();
                                });
                        });
                    }
                }
            } else { // Manual mode
                // Get current manual PWM states
                const manualStates = await new Promise((resolve, reject) => {
                    configDb.all('SELECT pin, value, enabled FROM pwm_states', [], (err, rows) => {
                        if (err) reject(err);
                        else {
                            const states = rows.reduce((acc, row) => {
                                acc[row.pin] = { value: row.value, enabled: row.enabled };
                                return acc;
                            }, {});
                            resolve(states);
                        }
                    });
                });

                // Update hardware based on manual states
                for (const [pin, state] of Object.entries(manualStates)) {
                    if (pwmPins[pin]) {
                        if (state.enabled) {
                            const pwmValue = Math.floor((state.value / 1023) * 255);
                            pwmPins[pin].pwmWrite(pwmValue);
                        } else {
                            pwmPins[pin].pwmWrite(0);
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error in control loop:', error);
    }
}

// Start control loop
setInterval(controlLoop, 1000);

// Publish node status to MQTT
async function publishNodeStatus() {
    if (!mqttClient || !mqttClient.connected) return;
    
    try {
        const [systemInfo, safetyStates, mode, pwmStates] = await Promise.all([
            // Get system info
            SystemInfo.getSystemInfo(),
            
            // Get safety states
            new Promise((resolve, reject) => {
                configDb.all('SELECT key, value FROM safety_state', [], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows.reduce((acc, row) => {
                        acc[row.key] = row.value === 1;
                        return acc;
                    }, {}));
                });
            }),
            
            // Get current mode
            new Promise((resolve, reject) => {
                configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.value : 1);
                });
            }),
            
            // Get PWM states
            new Promise((resolve, reject) => {
                configDb.all('SELECT pin, value, enabled FROM pwm_states', [], (err, rows) => {
                    if (err) reject(err);
                    else {
                        const states = {};
                        rows.forEach(row => {
                            states[row.pin] = {
                                value: row.value,
                                enabled: row.enabled === 1
                            };
                        });
                        resolve(states);
                    }
                });
            })
        ]);

        // Get network info directly to ensure we have the latest IP
        const networkInfo = SystemInfo.getNetworkInfo();
        console.log('Publishing node status with IP:', networkInfo.ipAddress);

        const status = {
            nodeId,
            timestamp: new Date().toISOString(),
            hostname: os.hostname(),
            ip: networkInfo.ipAddress,
            system: {
                uptime: systemInfo.system.piUptime,
                cpuTemp: systemInfo.system.cpuTemp,
                internetConnected: systemInfo.system.internetConnected
            },
            safety: safetyStates,
            mode: mode === 0 ? 'automatic' : 'manual',
            pwm: pwmStates
        };
        
        console.log('Publishing status:', JSON.stringify(status, null, 2));
        mqttClient.publish(`undergrowth/nodes/${nodeId}/status`, JSON.stringify(status), { qos: 1, retain: true });
    } catch (error) {
        console.error('Error publishing node status:', error);
    }
}

// ======================================
// MQTT CONNECTION MANAGEMENT
// ======================================
// Function to try connecting to MQTT broker, with backoff retry
async function initializeMqtt() {
    try {
        // Clear any existing retry timeout
        if (brokerRetryTimeout) {
            clearTimeout(brokerRetryTimeout);
            brokerRetryTimeout = null;
        }
        
        console.log('Attempting to discover MQTT broker...');
        const broker = await discoverBroker();
        console.log(`Found MQTT broker: ${broker.address}:${broker.port}`);
        
        mqttClient = connectToBroker(nodeId);
        
        // Subscribe to topics
        mqttClient.subscribe(`${nodeId}/#`, (err) => {
            if (err) {
                console.error('Error subscribing to topics:', err);
            } else {
                addSubscribedTopic(`${nodeId}/#`);
            }
        });

        // Subscribe to server requests topics
        mqttClient.subscribe(`undergrowth/server/requests/${nodeId}/#`, (err) => {
            if (err) {
                console.error('Error subscribing to server requests topics:', err);
            } else {
                console.log(`Subscribed to topic: undergrowth/server/requests/${nodeId}/#`);
                addSubscribedTopic(`undergrowth/server/requests/${nodeId}/#`);
            }
        });

        // Handle incoming messages
        mqttClient.on('message', (topic, message) => {
            updateLastMessageTime();
            console.log(`Received message on ${topic}:`, message.toString());
            
            // Handle data history requests from server
            if (topic === `undergrowth/server/requests/${nodeId}/history`) {
                try {
                    const request = JSON.parse(message.toString());
                    console.log(`Processing server history request:`, 
                        request.startSequence !== undefined ? 
                        `sequence-based (${request.startSequence} to ${request.endSequence || 'latest'})` : 
                        `time-based (${request.startTime} to ${request.endTime})`);
                    handleHistoryRequest(request);
                } catch (error) {
                    console.error('Error handling history request:', error);
                }
            }
        });

        return true;
    } catch (error) {
        console.log('MQTT broker discovery failed:', error.message);
        console.log('Node will run in standalone mode. MQTT features disabled.');
        
        // Schedule retry with exponential backoff
        const retryMinutes = Math.min(30, Math.pow(2, mqttState.reconnectionAttempts));
        mqttState.reconnectionAttempts++;
        console.log(`Will retry MQTT connection in ${retryMinutes} minutes`);
        
        brokerRetryTimeout = setTimeout(() => {
            initializeMqtt();
        }, retryMinutes * 60 * 1000);
        
        return false;
    }
}

// ======================================
// PORT FALLBACK LOGIC
// ======================================
function startServer(port) {
    return new Promise((resolve, reject) => {
        // Set up error handler for this attempt
        const errorHandler = (error) => {
            if (error.code === 'EADDRINUSE') {
                console.log(`Port ${port} is already in use, will try next port`);
                server.removeListener('error', errorHandler);
                resolve(false);
            } else {
                reject(error);
            }
        };

        server.once('error', errorHandler);

        server.listen(port, () => {
            console.log(`Server is running on port ${port}`);
            server.removeListener('error', errorHandler);
            resolve(true);
        });
    });
}

async function tryPorts() {
    for (const port of PORTS_TO_TRY) {
        console.log(`Attempting to start server on port ${port}...`);
        try {
            const success = await startServer(port);
            if (success) {
                console.log(`Server successfully started on port ${port}`);
                return true;
            }
        } catch (error) {
            console.error(`Error starting server on port ${port}:`, error);
        }
    }
    
    console.error('Failed to start server on any available port');
    return false;
}

// ======================================
// MAIN INIT FUNCTION - MODIFIED
// ======================================
// Initialize Raspberry Pi and then start the application
raspi.init(async () => {
    console.log(`Node ID: ${nodeId}`);
    console.log(`Startup Time: ${new Date().toISOString()}`);
    
    console.log('\n------------------System Configuration-----------------');
    // Get network info first
    const networkInfo = SystemInfo.getNetworkInfo();
    console.log(`Network Interface: ${networkInfo.interface || 'wlan0'}, IP: ${networkInfo.ipAddress}, MAC: ${networkInfo.macAddress}`);
    
    // Check time sync status at startup
    await SystemInfo.checkTimeSync();
    
    // Check internet connectivity
    await SystemInfo.checkInternetConnectivity();
    
    // Get system timezone
    await SystemInfo.getSystemTimezone();
    
    console.log('\n------------------Database Initialization-----------------');
    // Enable database logging
    shouldLogDatabase = true;
    // Re-trigger database connection logs
    console.log('Connected to config database');
    console.log('Connected to data database');
    
    console.log('\n------------------Hardware Initialization-----------------');
    // Initialize hardware and services
    initPwmPins(); // Initialize PWM pins
    
    console.log('\n------------------Sensor Initialization-----------------');
    // Initialize sensors and start data collection
    await initAndRead();
    
    // Add default sensors to config if database is empty
    configDb.get('SELECT COUNT(*) as count FROM sensor_config', [], (err, row) => {
        if (err) {
            console.error('Error checking sensor config:', err);
            return;
        }
        
        if (row.count === 0) {
            console.log('No sensors configured, adding default AHT10 sensors');
            
            // Add the two default AHT10 sensors
            configDb.run(
                'INSERT INTO sensor_config (address, type, name, enabled) VALUES (?, ?, ?, ?)',
                ['0x38-AHT10', 'AHT10', 'AHT10 Sensor 1', 1],
                (err) => {
                    if (err) console.error('Error adding default sensor 1:', err);
                    else console.log('Added default sensor 1 (0x38-AHT10)');
                }
            );
            
            configDb.run(
                'INSERT INTO sensor_config (address, type, name, enabled) VALUES (?, ?, ?, ?)',
                ['0x39-AHT10', 'AHT10', 'AHT10 Sensor 2', 1],
                (err) => {
                    if (err) console.error('Error adding default sensor 2:', err);
                    else console.log('Added default sensor 2 (0x39-AHT10)');
                    
                    // Reload sensors after adding defaults
                    loadSensors().catch(err => console.error('Error loading sensors after adding defaults:', err));
                }
            );
        }
    });
    
    console.log('\n------------------MQTT Configuration-----------------');
    // Try to discover and connect to MQTT broker - but don't block startup if it fails
    try {
        const mqttInitialized = await initializeMqtt();
        if (mqttInitialized) {
            console.log('MQTT successfully initialized');
            // Start periodic status updates to MQTT
            setInterval(() => {
                if (mqttClient && mqttClient.connected) {
                    publishNodeStatus();
                }
            }, 60000); // Send status every minute
        } else {
            console.log('MQTT initialization skipped. Node running in standalone mode.');
        }
    } catch (error) {
        console.error('Error during MQTT initialization:', error);
        console.log('Continuing without MQTT support');
    }
    
    console.log('\n------------------Webserver Initialization-----------------');
    // Start server on port 80 only
    server.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
        console.log('\n========== Startup Complete ============');
        console.log(`Web UI accessible at: http://${networkInfo.ipAddress}:${PORT}`);
        console.log('\n========================================\n');
    });
});

// Handle historical data requests
function handleHistoryRequest(request) {
    console.log('Received history request:', request);
    
    // Check if this is a sequence-based or time-based request
    const isSequenceBased = request.startSequence !== undefined;
    
    if (isSequenceBased) {
        // Handle sequence-based request
        if (!request.requestId) {
            console.error('Invalid sequence-based request, missing requestId');
            return;
        }
        
        // Use the getDataBySequenceRange function that already exists
        const startSequence = request.startSequence;
        const endSequence = request.endSequence || Number.MAX_SAFE_INTEGER;
        const limit = request.limit || 1000;
        
        getDataBySequenceRange(startSequence, endSequence, limit)
            .then(rows => {
                // Get the actual max sequence from the database
                return getSequenceRange()
                    .then(sequenceRange => {
                        // Format response
                        const response = {
                            nodeId,
                            requestId: request.requestId,
                            startSequence: startSequence,
                            endSequence: rows.length > 0 ? rows[rows.length - 1].sequence_id : startSequence,
                            maxSequence: sequenceRange.maxSequence, // Use the actual max sequence from the database
                            dataPoints: rows.map(row => ({
                                timestamp: row.timestamp,
                                sensorId: row.device_id,
                                type: row.type,
                                value: row.value,
                                sequence_id: row.sequence_id
                            })),
                            recordCount: rows.length
                        };
                        
                        console.log(`Sending sequence-based history response with ${rows.length} records (max sequence: ${sequenceRange.maxSequence})`);
                        
                        // Send response
                        if (mqttClient && mqttClient.connected) {
                            mqttClient.publish(`undergrowth/nodes/${nodeId}/history`, JSON.stringify(response), { 
                                qos: 1 
                            });
                            
                            // Update server_sync table to track sync progress
                            const now = new Date().toISOString();
                            configDb.run(
                                'INSERT OR REPLACE INTO server_sync (server_id, last_sync_time, last_sequence, last_seen) VALUES (?, ?, ?, ?)',
                                ['server', now, response.endSequence, now],
                                (err) => {
                                    if (err) {
                                        console.error('Error updating server_sync table:', err);
                                    } else {
                                        console.log(`Updated server sync record to sequence ${response.endSequence}`);
                                    }
                                }
                            );
                        } else {
                            console.log('MQTT client not connected, history response could not be sent');
                        }
                    });
            })
            .catch(err => {
                console.error('Error querying sequence-based sensor history:', err);
                
                // Send error response
                if (mqttClient && mqttClient.connected) {
                    mqttClient.publish(`undergrowth/nodes/${nodeId}/history/error`, JSON.stringify({
                        nodeId,
                        requestId: request.requestId,
                        error: 'Database query error',
                        message: err.message
                    }), { qos: 1 });
                }
            });
    } else {
        // Handle time-based request (existing code)
        if (!request.startTime || !request.endTime || !request.requestId) {
            console.error('Invalid time-based request, missing required fields');
            return;
        }
        
        // Query the database for sensor readings in the requested time range
        const query = `
            SELECT timestamp, device_id, type, value
            FROM sensor_readings
            WHERE timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `;
        
        dataDb.all(query, [request.startTime, request.endTime], (err, rows) => {
            if (err) {
                console.error('Error querying sensor history:', err);
                
                // Send error response
                if (mqttClient && mqttClient.connected) {
                    mqttClient.publish(`undergrowth/nodes/${nodeId}/history/error`, JSON.stringify({
                        nodeId,
                        requestId: request.requestId,
                        error: 'Database query error',
                        message: err.message
                    }), { qos: 1 });
                }
                return;
            }
            
            // Get max sequence information if available
            getSequenceRange()
                .then(sequenceRange => {
                    // Format response
                    const response = {
                        nodeId,
                        requestId: request.requestId,
                        startTime: request.startTime,
                        endTime: request.endTime,
                        // Include sequence info if available
                        maxSequence: sequenceRange.maxSequence,
                        dataPoints: rows.map(row => ({
                            timestamp: row.timestamp,
                            sensorId: row.device_id,
                            type: row.type,
                            value: row.value
                        })),
                        recordCount: rows.length
                    };
                    
                    console.log(`Sending time-based history response with ${rows.length} records (max sequence: ${sequenceRange.maxSequence})`);
                    
                    // Send response
                    if (mqttClient && mqttClient.connected) {
                        mqttClient.publish(`undergrowth/nodes/${nodeId}/history`, JSON.stringify(response), { 
                            qos: 1 
                        });
                        
                        // Update server_sync table to track last contact, but not sequence since this was time-based
                        const now = new Date().toISOString();
                        configDb.run(
                            'INSERT OR REPLACE INTO server_sync (server_id, last_sync_time, last_seen) VALUES (?, ?, ?)',
                            ['server', now, now],
                            (err) => {
                                if (err) {
                                    console.error('Error updating server_sync table:', err);
                                }
                            }
                        );
                    } else {
                        console.log('MQTT client not connected, history response could not be sent');
                    }
                })
                .catch(err => {
                    console.error('Error getting sequence range:', err);
                    
                    // Fall back to response without sequence information
                    const response = {
                        nodeId,
                        requestId: request.requestId,
                        startTime: request.startTime,
                        endTime: request.endTime,
                        dataPoints: rows.map(row => ({
                            timestamp: row.timestamp,
                            sensorId: row.device_id,
                            type: row.type,
                            value: row.value
                        })),
                        recordCount: rows.length
                    };
                    
                    console.log(`Sending time-based history response with ${rows.length} records (without sequence info)`);
                    
                    if (mqttClient && mqttClient.connected) {
                        mqttClient.publish(`undergrowth/nodes/${nodeId}/history`, JSON.stringify(response), { 
                            qos: 1 
                        });
                    } else {
                        console.log('MQTT client not connected, history response could not be sent');
                    }
                });
        });
    }
}

// API endpoint for sequence information 
app.get('/api/sequence-info', async (req, res) => {
    try {
        // Get sequence range from database
        const sequenceRange = await getSequenceRange();
        
        // Get first and last timestamps
        let firstTimestamp = null;
        let lastTimestamp = null;
        
        if (sequenceRange.minSequence > 0) {
            // Get first record timestamp
            const firstRecord = await new Promise((resolve, reject) => {
                dataDb.get(
                    'SELECT timestamp FROM sensor_readings WHERE sequence_id = ? LIMIT 1',
                    [sequenceRange.minSequence],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });
            
            if (firstRecord) {
                firstTimestamp = firstRecord.timestamp;
            }
        }
        
        if (sequenceRange.maxSequence > 0) {
            // Get latest record timestamp
            const lastRecord = await new Promise((resolve, reject) => {
                dataDb.get(
                    'SELECT timestamp FROM sensor_readings WHERE sequence_id = ? LIMIT 1',
                    [sequenceRange.maxSequence],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });
            
            if (lastRecord) {
                lastTimestamp = lastRecord.timestamp;
            }
        }
        
        // Get server sync information
        const serverSync = await new Promise((resolve, reject) => {
            configDb.get(
                'SELECT * FROM server_sync ORDER BY last_seen DESC LIMIT 1',
                [],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                }
            );
        });
        
        // Calculate sync gap
        let syncGap = 0;
        if (serverSync && sequenceRange.maxSequence > 0) {
            syncGap = sequenceRange.maxSequence - (serverSync.last_sequence || 0);
        }
        
        // Get server sync status with more details
        let serverSyncDetails = null;
        if (serverSync) {
            // Get the timestamp of the last synced record
            let lastSyncedTimestamp = null;
            if (serverSync.last_sequence > 0) {
                const syncedRecord = await new Promise((resolve, reject) => {
                    dataDb.get(
                        'SELECT timestamp FROM sensor_readings WHERE sequence_id = ? LIMIT 1',
                        [serverSync.last_sequence],
                        (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        }
                    );
                });
                
                if (syncedRecord) {
                    lastSyncedTimestamp = syncedRecord.timestamp;
                }
            }
            
            // Count how many records have been sent to server
            const sentCount = await new Promise((resolve, reject) => {
                dataDb.get(
                    'SELECT COUNT(*) as count FROM sensor_readings WHERE sequence_id <= ?',
                    [serverSync.last_sequence || 0],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row.count || 0);
                    }
                );
            });
            
            serverSyncDetails = {
                ...serverSync,
                sentCount,
                lastSyncedTimestamp,
                syncGap
            };
        }
        
        // Send response
        res.json({
            nodeSequence: {
                ...sequenceRange,
                firstTimestamp,
                lastTimestamp
            },
            serverSync: serverSyncDetails || null
        });
    } catch (error) {
        console.error('Error getting sequence info:', error);
        res.status(500).json({ error: 'Failed to get sequence information' });
    }
}); 