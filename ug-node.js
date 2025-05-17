const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const raspi = require('raspi');
const { I2C } = require('raspi-i2c');
const AHT10 = require('./aht10');
const SystemInfo = require('./systemInfo');
const Gpio = require('pigpio').Gpio;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const os = require('os');
const MQTTController = require('./mqtt');

console.log('\n============ Startup Initiated ============');

// Define the port constant
const PORT = 80;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Initialize system info
const systemInfo = new SystemInfo();

// Replace all MQTT state variables with a single controller instance
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

// Initialize MQTT controller
const mqttController = new MQTTController(nodeId);

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
                
                // Apply PWM values to hardware immediately if enabled
                if (row.enabled === 1 && pwmEnabled) {
                    // Database stores values 0-1023, but pigpio expects 0-255
                    // Scale from database range to hardware range
                    const dbValue = row.value; // 0-1023
                    const hardwareValue = Math.floor((dbValue / 1023) * 255); // 0-255
                    
                    console.log(`Setting initial PWM for GPIO${pin}: ${dbValue}/1023 -> ${hardwareValue}/255 (${Math.round((dbValue / 1023) * 100)}%)`);
                    
                    try {
                        pwmPins[pin].pwmWrite(hardwareValue);
                        pwmPins[pin]._dbValue = dbValue;
                    } catch (e) {
                        console.error(`Error setting initial PWM for GPIO${pin}:`, e.message);
                    }
                }
            }
        });
    });
}

// Add a new function to manually apply PWM states from database
function applyPwmStatesFromDb() {
    console.log('Manually applying PWM states from database...');
    
    // Get current safety states
    configDb.all('SELECT key, value FROM safety_state', [], (err, safetyRows) => {
        if (err) {
            console.error('Error getting safety state:', err);
            return;
        }
        
        const safetyStates = safetyRows.reduce((acc, row) => {
            acc[row.key] = row.value;
            return acc;
        }, {});
        
        // Check if system is in a safe state
        const isEmergencyStop = safetyStates.emergency_stop === 1;
        const isNormalEnable = safetyStates.normal_enable === 1;
        
        if (isEmergencyStop || !isNormalEnable) {
            console.log('System not in safe state, PWM values will not be applied');
            return;
        }
        
        // Get current mode
        configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, modeRow) => {
            if (err) {
                console.error('Error getting mode:', err);
                return;
            }
            
            const mode = modeRow ? modeRow.value : 1; // Default to manual mode
            console.log(`Current mode: ${mode === 0 ? 'automatic' : 'manual'} (${mode})`);
            
            // Get PWM states based on mode
            const statesTable = mode === 0 ? 'auto_pwm_states' : 'pwm_states';
            
            configDb.all(`SELECT pin, value, enabled FROM ${statesTable}`, [], (err, rows) => {
                if (err) {
                    console.error(`Error loading ${statesTable}:`, err);
                    return;
                }
                
                console.log(`Found ${rows.length} PWM states in ${statesTable}`);
                
                // Apply PWM values to hardware
                rows.forEach(row => {
                    const pin = row.pin;
                    if (pwmPins[pin] && pwmEnabled) {
                        if (row.enabled === 1) {
                            // Database stores values 0-1023, but pigpio expects 0-255
                            // Scale from database range to hardware range
                            const dbValue = row.value; // 0-1023
                            const hardwareValue = Math.floor((dbValue / 1023) * 255); // 0-255
                            
                            console.log(`Setting PWM for GPIO${pin}: ${dbValue}/1023 -> ${hardwareValue}/255 (${Math.round((dbValue / 1023) * 100)}%)`);
                            
                            try {
                                pwmPins[pin].pwmWrite(hardwareValue);
                                // Store the original database value on the pin object for reference
                                pwmPins[pin]._dbValue = dbValue;
                            } catch (e) {
                                console.error(`Error setting PWM for GPIO${pin}:`, e.message);
                            }
                        } else {
                            console.log(`GPIO${pin} is disabled, setting to 0`);
                            try {
                                pwmPins[pin].pwmWrite(0);
                                pwmPins[pin]._dbValue = 0;
                            } catch (e) {
                                console.error(`Error setting PWM for GPIO${pin} to 0:`, e.message);
                            }
                        }
                    }
                });
            });
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
    res.redirect('/pwm');
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
    mqttController.publishSensorData(sensor1Data, sensor2Data, configuredSensorData);
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

// Update togglePWM function with better error handling
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
                            console.log(`togglePWM: Setting GPIO${pin} to ${pwmValue} (${value}/1023)`);
                            try {
                                pwmPins[pin].pwmWrite(pwmValue);
                                pwmPins[pin]._pwmValue = value;
                            } catch (e) {
                                console.error(`Error in togglePWM for GPIO${pin}:`, e.message);
                            }
                        } else {
                            console.log(`togglePWM: Disabling GPIO${pin}`);
                            try {
                                pwmPins[pin].pwmWrite(0);
                                pwmPins[pin]._pwmValue = 0;
                            } catch (e) {
                                console.error(`Error in togglePWM for GPIO${pin}:`, e.message);
                            }
                        }
                    } else {
                        console.log(`togglePWM: Not updating hardware - mode:${mode}, pwmEnabled:${pwmEnabled}, pin:${pin}`);
                    }
                    
                    // Broadcast the new state to all clients
                    broadcastPWMState();
                    
                    resolve();
                });
            });
        });
    });
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
    try {
        // Keep all the code that gathers status information
        const [systemInfo, safetyStates, mode, pwmStates, sequenceRange] = await Promise.all([
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
            }),
            
            // Get sequence range
            getSequenceRange()
        ]);
        
        // Get sensor statistics
        const sensorStats = await new Promise((resolve, reject) => {
            // Get all sensors from config
            configDb.all('SELECT * FROM sensor_config', [], async (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                const sensors = rows || [];
                // Add legacy sensors
                const allSensors = [
                    ...sensors,
                    { id: 'legacy1', address: '0x38', type: 'AHT10', name: 'Legacy AHT10 (0x38)' },
                    { id: 'legacy2', address: '0x39', type: 'AHT10', name: 'Legacy AHT10 (0x39)' }
                ];
                
                // Get stats for each sensor
                const sensorStats = [];
                let totalRecordCount = 0;
                
                for (const sensor of allSensors) {
                    // Determine device_id format
                    let deviceId;
                    if (sensor.id === 'legacy1') {
                        deviceId = 'sensor1';
                    } else if (sensor.id === 'legacy2') {
                        deviceId = 'sensor2';
                    } else {
                        deviceId = `sensor_${sensor.id}`;
                    }
                    
                    // Get temperature record count
                    const tempCount = await new Promise((resolve, reject) => {
                        dataDb.get(
                            'SELECT COUNT(*) as count FROM sensor_readings WHERE device_id = ? AND type = ?',
                            [deviceId, 'temperature'],
                            (err, row) => {
                                if (err) reject(err);
                                else resolve(row ? row.count : 0);
                            }
                        );
                    });
                    
                    // Get humidity record count
                    const humidityCount = await new Promise((resolve, reject) => {
                        dataDb.get(
                            'SELECT COUNT(*) as count FROM sensor_readings WHERE device_id = ? AND type = ?',
                            [deviceId, 'humidity'],
                            (err, row) => {
                                if (err) reject(err);
                                else resolve(row ? row.count : 0);
                            }
                        );
                    });
                    
                    // Calculate total for this sensor
                    const sensorTotal = tempCount + humidityCount;
                    totalRecordCount += sensorTotal;
                    
                    sensorStats.push({
                        id: sensor.id,
                        deviceId: deviceId,
                        name: sensor.name || `${sensor.type} ${sensor.address}`,
                        address: sensor.address,
                        type: sensor.type,
                        temperatureCount: tempCount,
                        humidityCount: humidityCount,
                        totalCount: sensorTotal
                    });
                }
                
                resolve({
                    sensors: sensorStats,
                    totalRecordCount
                });
            });
        });

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
            pwm: pwmStates,
            // Add sequence range and sensor stats information
            data: {
                sequenceRange,
                sensorStats: sensorStats.sensors,
                totalRecords: sensorStats.totalRecordCount
            }
        };
        
        // Use our module to publish instead of direct MQTT client call
        mqttController.publishNodeStatus(status);
    } catch (error) {
        console.error('Error publishing node status:', error);
    }
}

// Replace initializeMqtt function with our controller's initialize method
async function initializeMqtt() {
    try {
        const initialized = await mqttController.initialize();
        
        // Set up message handlers after initialization
        if (initialized) {
            // Handle incoming messages
            mqttController.on('message', (topic, message) => {
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
            
            console.log('MQTT successfully initialized');
            
            // Start periodic status updates
            setInterval(() => {
                if (mqttController.getBrokerInfo().connected) {
                    publishNodeStatus();
                }
            }, 60000); // Send status every minute
        } else {
            console.log('MQTT initialization skipped. Node running in standalone mode.');
        }
        
        return initialized;
    } catch (error) {
        console.error('Error during MQTT initialization:', error);
        console.log('Continuing without MQTT support');
        return false;
    }
}

// Modify handleHistoryRequest to use our MQTT controller
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
                        
                        // Send response using our MQTT controller
                        mqttController.publish(`undergrowth/nodes/${nodeId}/history`, response)
                            .then(() => {
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
                            })
                            .catch(err => {
                                console.error('Failed to publish history response:', err);
                            });
                    });
            })
            .catch(err => {
                console.error('Error querying sequence-based sensor history:', err);
                
                // Send error response using our MQTT controller
                mqttController.publish(`undergrowth/nodes/${nodeId}/history/error`, {
                    nodeId,
                    requestId: request.requestId,
                    error: 'Database query error',
                    message: err.message
                }).catch(err => {
                    console.error('Failed to publish error response:', err);
                });
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
                
                // Send error response using our MQTT controller
                mqttController.publish(`undergrowth/nodes/${nodeId}/history/error`, {
                    nodeId,
                    requestId: request.requestId,
                    error: 'Database query error',
                    message: err.message
                }).catch(err => {
                    console.error('Failed to publish error response:', err);
                });
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
                    
                    // Send response using our MQTT controller
                    mqttController.publish(`undergrowth/nodes/${nodeId}/history`, response)
                        .then(() => {
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
                        })
                        .catch(err => {
                            console.error('Failed to publish history response:', err);
                        });
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
                    
                    mqttController.publish(`undergrowth/nodes/${nodeId}/history`, response)
                        .catch(err => {
                            console.error('Failed to publish history response:', err);
                        });
                });
        });
    }
}

// Modify the section where you initialize MQTT in the main init function
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
    // Apply PWM states after pin initialization
    setTimeout(() => {
        console.log('Applying saved PWM states to hardware...');
        applyPwmStatesFromDb();
    }, 1000); // Small delay to ensure pins are ready
    
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
            // Note: Status updates are now set up in the initializeMqtt function
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

// API endpoint for individual sensor statistics
app.get('/api/sensor-stats/:sensorId', async (req, res) => {
  try {
    const sensorId = req.params.sensorId;
    
    // Get sensor details first
    const sensor = await new Promise((resolve, reject) => {
      configDb.get('SELECT * FROM sensor_config WHERE id = ?', [sensorId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!sensor) {
      return res.status(404).json({ error: 'Sensor not found' });
    }
    
    // Convert sensor ID to device_id format for query
    const deviceId = `sensor_${sensorId}`;
    
    // Get total record count
    const recordCount = await new Promise((resolve, reject) => {
      dataDb.get(
        'SELECT COUNT(*) as count FROM sensor_readings WHERE device_id = ?',
        [deviceId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? row.count : 0);
        }
      );
    });
    
    // Get first timestamp
    const firstRecord = await new Promise((resolve, reject) => {
      dataDb.get(
        'SELECT timestamp FROM sensor_readings WHERE device_id = ? ORDER BY timestamp ASC LIMIT 1',
        [deviceId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    // Get last timestamp
    const lastRecord = await new Promise((resolve, reject) => {
      dataDb.get(
        'SELECT timestamp FROM sensor_readings WHERE device_id = ? ORDER BY timestamp DESC LIMIT 1',
        [deviceId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    // Send response
    res.json({
      sensorId,
      address: sensor.address,
      type: sensor.type,
      recordCount,
      firstTimestamp: firstRecord ? firstRecord.timestamp : null,
      lastTimestamp: lastRecord ? lastRecord.timestamp : null
    });
  } catch (error) {
    console.error(`Error getting sensor stats for sensor ${req.params.sensorId}:`, error);
    res.status(500).json({ error: 'Failed to get sensor statistics' });
  }
});

// New API endpoint for sensor statistics summary
app.get('/api/sensor-stats/summary', async (req, res) => {
  try {
    // Get all sensors from config
    const sensors = await new Promise((resolve, reject) => {
      configDb.all('SELECT * FROM sensor_config', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // Add legacy sensors (always include in stats)
    const allSensors = [
      ...sensors,
      { id: 'legacy1', address: '0x38', type: 'AHT10', name: 'Legacy AHT10 (0x38)', deviceId: 'sensor1' },
      { id: 'legacy2', address: '0x39', type: 'AHT10', name: 'Legacy AHT10 (0x39)', deviceId: 'sensor2' }
    ];
    
    // Log what we're doing for debugging
    console.log(`Processing statistics for ${allSensors.length} sensors`);
    
    // Get stats for each sensor
    const sensorStats = [];
    let totalRecordCount = 0;
    
    for (const sensor of allSensors) {
      // Determine device_id format
      let deviceId;
      if (sensor.deviceId) {
        deviceId = sensor.deviceId; // Use predefined deviceId if available (for legacy sensors)
      } else if (sensor.id === 'legacy1') {
        deviceId = 'sensor1';
      } else if (sensor.id === 'legacy2') {
        deviceId = 'sensor2';
      } else {
        deviceId = `sensor_${sensor.id}`;
      }
      
      console.log(`Fetching stats for sensor ${sensor.id} (${sensor.address}) using deviceId: ${deviceId}`);
      
      // Get temperature record count
      const tempCount = await new Promise((resolve, reject) => {
        dataDb.get(
          'SELECT COUNT(*) as count FROM sensor_readings WHERE device_id = ? AND type = ?',
          [deviceId, 'temperature'],
          (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.count : 0);
          }
        );
      });
      
      // Get humidity record count
      const humidityCount = await new Promise((resolve, reject) => {
        dataDb.get(
          'SELECT COUNT(*) as count FROM sensor_readings WHERE device_id = ? AND type = ?',
          [deviceId, 'humidity'],
          (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.count : 0);
          }
        );
      });
      
      // Get first timestamp
      const firstRecord = await new Promise((resolve, reject) => {
        dataDb.get(
          'SELECT timestamp FROM sensor_readings WHERE device_id = ? ORDER BY timestamp ASC LIMIT 1',
          [deviceId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });
      
      // Calculate total for this sensor
      const sensorTotal = tempCount + humidityCount;
      totalRecordCount += sensorTotal;
      
      console.log(`Sensor ${sensor.id} (${sensor.address}): temp=${tempCount}, humid=${humidityCount}, total=${sensorTotal}, first=${firstRecord?.timestamp || 'none'}`);
      
      sensorStats.push({
        id: sensor.id,
        deviceId: deviceId,
        name: sensor.name || `${sensor.type} ${sensor.address}`,
        address: sensor.address,
        type: sensor.type,
        temperatureCount: tempCount,
        humidityCount: humidityCount,
        totalCount: sensorTotal,
        firstTimestamp: firstRecord ? firstRecord.timestamp : null
      });
    }
    
    // Send response
    res.json({
      sensors: sensorStats,
      totalRecordCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting sensor statistics summary:', error);
    res.status(500).json({ error: 'Failed to get sensor statistics summary' });
  }
});

// Update the emitBrokerInfo function to use our MQTT controller
function emitBrokerInfo() {
    if (!io) return;
    
    const info = mqttController.getBrokerInfo();
    io.emit('brokerInfo', {
        connected: info.connected,
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

    // Handle PWM Set request - THIS IS MISSING
    socket.on('pwmSet', async (data) => {
        try {
            const { pin, value } = data;
            
            // Validate input
            if (!pin || value === undefined || !pwmPins[pin]) {
                socket.emit('pwmError', { pin, message: 'Invalid pin or value', blocked: false });
                return;
            }
            
            // Check if system is in a safe state
            const isSafe = await isSystemSafe();
            if (!isSafe) {
                socket.emit('pwmError', { pin, message: 'System is in emergency stop, cannot set PWM', blocked: true });
                return;
            }
            
            // Get current mode
            const currentMode = await new Promise((resolve, reject) => {
                configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.value : 1); // Default to manual mode (1)
                });
            });
            
            // Don't allow PWM changes in automatic mode
            if (currentMode === 0) {
                socket.emit('pwmError', { pin, message: 'Cannot change PWM in automatic mode', blocked: true });
                return;
            }
            
            console.log(`Setting PWM for pin ${pin} to ${value}`);
            
            // Update database
            configDb.run('INSERT OR REPLACE INTO pwm_states (pin, value, enabled, last_modified) VALUES (?, ?, (SELECT enabled FROM pwm_states WHERE pin = ?), CURRENT_TIMESTAMP)',
                [pin, value, pin],
                (err) => {
                    if (err) {
                        console.error('Error updating PWM value in database:', err);
                        socket.emit('pwmError', { pin, message: 'Database error', blocked: false });
                        return;
                    }
                    
                    // Update hardware if PWM is enabled
                    if (pwmEnabled && pwmPins[pin]) {
                        // Get current enabled state
                        configDb.get('SELECT enabled FROM pwm_states WHERE pin = ?', [pin], (err, row) => {
                            if (err) {
                                console.error('Error getting PWM enabled state:', err);
                                return;
                            }
                            
                            // Only write to the pin if it's enabled
                            if (row && row.enabled === 1) {
                                // Scale from 0-1023 to 0-255 for hardware
                                const pwmValue = Math.floor((value / 1023) * 255);
                                console.log(`Writing PWM value ${pwmValue} (from ${value}) to pin ${pin}`);
                                pwmPins[pin].pwmWrite(pwmValue);
                            }
                            
                            // Broadcast updated PWM state to all clients
                            broadcastPWMState();
                        });
                    } else {
                        // Still broadcast state even if hardware control is disabled
                        broadcastPWMState();
                    }
                }
            );
        } catch (error) {
            console.error('Error in pwmSet handler:', error);
            socket.emit('pwmError', { message: 'Server error: ' + error.message, blocked: false });
        }
    });
    
    // Handle PWM Toggle request - THIS IS MISSING
    socket.on('pwmToggle', async (data) => {
        try {
            const { pin, enabled } = data;
            
            // Validate input
            if (!pin || enabled === undefined || !pwmPins[pin]) {
                socket.emit('pwmError', { pin, message: 'Invalid pin or value', blocked: false });
                return;
            }
            
            // Check if system is in a safe state
            const isSafe = await isSystemSafe();
            if (!isSafe) {
                socket.emit('pwmError', { pin, message: 'System is in emergency stop, cannot toggle PWM', blocked: true });
                return;
            }
            
            // Get current mode
            const currentMode = await new Promise((resolve, reject) => {
                configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.value : 1); // Default to manual mode
                });
            });
            
            // Don't allow PWM changes in automatic mode
            if (currentMode === 0) {
                socket.emit('pwmError', { pin, message: 'Cannot change PWM in automatic mode', blocked: true });
                return;
            }
            
            console.log(`Toggling PWM for pin ${pin} to ${enabled ? 'enabled' : 'disabled'}`);
            
            // Use the existing togglePWM function which handles database and hardware updates
            await togglePWM(pin, enabled);
            
        } catch (error) {
            console.error('Error in pwmToggle handler:', error);
            socket.emit('pwmError', { message: 'Server error: ' + error.message, blocked: false });
        }
    });
    
    // Handle mode toggle request - THIS IS MISSING
    socket.on('setMode', async (data) => {
        try {
            const { automatic } = data;
            const mode = automatic ? 0 : 1; // 0 = automatic, 1 = manual
            
            console.log(`Setting mode to ${automatic ? 'automatic' : 'manual'} (${mode})`);
            
            // Update database
            configDb.run('UPDATE system_state SET value = ? WHERE key = ?', [mode, 'mode'], async (err) => {
                if (err) {
                    console.error('Error updating mode in database:', err);
                    return;
                }
                
                // Broadcast mode change to all clients
                io.emit('modeUpdate', { mode });
                
                // Also broadcast PWM state which includes mode information
                broadcastPWMState();
                
                // If switching to automatic mode, run the control loop to update outputs
                if (mode === 0) {
                    await controlLoop();
                }
            });
        } catch (error) {
            console.error('Error in setMode handler:', error);
        }
    });
    
    // Handle getInitialState request - THIS IS MISSING
    socket.on('getInitialState', async () => {
        try {
            // Get safety states
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
            
            // Get manual PWM states
            const manualPwmStates = await new Promise((resolve, reject) => {
                configDb.all('SELECT pin, value, enabled FROM pwm_states', [], (err, rows) => {
                    if (err) reject(err);
                    else {
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
            });
            
            // Get auto PWM states
            const autoPwmStates = await new Promise((resolve, reject) => {
                configDb.all('SELECT pin, value, enabled FROM auto_pwm_states', [], (err, rows) => {
                    if (err) reject(err);
                    else {
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
            });
            
            // Send initial state to client
            socket.emit('initialState', {
                safety: {
                    emergency_stop: safetyStates.emergency_stop === 1,
                    normal_enable: safetyStates.normal_enable === 1
                },
                safetyStates,
                mode,
                pwmStates: {
                    mode,
                    current: mode === 0 ? autoPwmStates : manualPwmStates,
                    manual: manualPwmStates,
                    auto: autoPwmStates
                }
            });
            
            // Get events data for schedule page
            configDb.all('SELECT id, gpio, time, pwm_value, enabled FROM events ORDER BY time', [], (err, rows) => {
                if (err) {
                    console.error('Error getting events for initial state:', err);
                    return;
                }
                
                // Include events data in the initial state if there are any
                if (rows && rows.length > 0) {
                    socket.emit('eventsUpdated', rows);
                }
            });
            
        } catch (error) {
            console.error('Error in getInitialState handler:', error);
        }
    });

    // Also add an applyPwmHardware command for debugging
    socket.on('applyPwmHardware', () => {
        console.log('Manual request to apply PWM hardware state received');
        applyPwmStatesFromDb();
    });

    // Handle event-related requests for schedule.html
    
    // Get all events
    socket.on('getEvents', () => {
        configDb.all('SELECT id, gpio, time, pwm_value, enabled FROM events ORDER BY time', [], (err, rows) => {
            if (err) {
                console.error('Error getting events:', err);
                socket.emit('error', { message: 'Failed to retrieve events' });
                return;
            }
            socket.emit('eventsUpdated', rows);
        });
    });

    // Add a new event
    socket.on('addEvent', (data) => {
        const { gpio, time, pwm_value, enabled } = data;
        
        if (!gpio || !time || pwm_value === undefined) {
            socket.emit('error', { message: 'Invalid event data' });
            return;
        }
        
        configDb.run('INSERT INTO events (gpio, time, pwm_value, enabled) VALUES (?, ?, ?, ?)',
            [gpio, time, pwm_value, enabled || 1],
            function(err) {
                if (err) {
                    console.error('Error adding event:', err);
                    socket.emit('error', { message: 'Failed to add event' });
                    return;
                }
                
                console.log(`Event added: GPIO${gpio} at ${time} with PWM ${pwm_value}`);
                
                // Send updated events to all clients
                configDb.all('SELECT id, gpio, time, pwm_value, enabled FROM events ORDER BY time', [], (err, rows) => {
                    if (err) {
                        console.error('Error getting events after add:', err);
                        return;
                    }
                    io.emit('eventsUpdated', rows);
                });
            }
        );
    });

    // Delete an event
    socket.on('deleteEvent', (data) => {
        const { id } = data;
        
        if (!id) {
            socket.emit('error', { message: 'Invalid event ID' });
            return;
        }
        
        configDb.run('DELETE FROM events WHERE id = ?', [id], function(err) {
            if (err) {
                console.error('Error deleting event:', err);
                socket.emit('error', { message: 'Failed to delete event' });
                return;
            }
            
            console.log(`Event ${id} deleted`);
            
            // Send updated events to all clients
            configDb.all('SELECT id, gpio, time, pwm_value, enabled FROM events ORDER BY time', [], (err, rows) => {
                if (err) {
                    console.error('Error getting events after delete:', err);
                    return;
                }
                io.emit('eventsUpdated', rows);
            });
        });
    });

    // Toggle event enabled state
    socket.on('toggleEvent', (data) => {
        const { id, enabled } = data;
        
        if (!id || enabled === undefined) {
            socket.emit('error', { message: 'Invalid event data' });
            return;
        }
        
        configDb.run('UPDATE events SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id], function(err) {
            if (err) {
                console.error('Error toggling event:', err);
                socket.emit('error', { message: 'Failed to toggle event' });
                return;
            }
            
            console.log(`Event ${id} toggled to ${enabled ? 'enabled' : 'disabled'}`);
            
            // Send updated events to all clients
            configDb.all('SELECT id, gpio, time, pwm_value, enabled FROM events ORDER BY time', [], (err, rows) => {
                if (err) {
                    console.error('Error getting events after toggle:', err);
                    return;
                }
                io.emit('eventsUpdated', rows);
            });
        });
    });

    // Handle emergency stop request
    socket.on('emergencyStop', async () => {
        console.log('Emergency stop requested');
        try {
            await emergencyStop();
            // Broadcast safety state update to all clients
            broadcastSafetyState();
            // Also emit specific event for compatibility
            io.emit('emergencyStop');
            // Stop all PWM outputs
            if (pwmEnabled) {
                for (const pin of Object.keys(pwmPins)) {
                    if (pwmPins[pin]) {
                        try {
                            console.log(`Emergency stop: Setting GPIO${pin} to 0`);
                            pwmPins[pin].pwmWrite(0);
                        } catch (e) {
                            console.error(`Error setting GPIO${pin} to 0:`, e.message);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error in emergencyStop handler:', error);
        }
    });

    // Handle clear emergency stop request
    socket.on('clearEmergencyStop', async () => {
        console.log('Clear emergency stop requested');
        try {
            await clearEmergencyStop();
            // Broadcast safety state update to all clients
            broadcastSafetyState();
            // Also emit specific event for compatibility
            io.emit('clearEmergencyStop');
            // Re-apply PWM states from database
            applyPwmStatesFromDb();
        } catch (error) {
            console.error('Error in clearEmergencyStop handler:', error);
        }
    });
}); 