const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const raspi = require('raspi');
const { I2C } = require('raspi-i2c');
const AHT10 = require('./aht10');
const SystemInfo = require('./systemInfo');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const os = require('os');
const MQTTController = require('./node-mqtt-controller');
const GpioController = require('./gpio-controller');
const initializeApiRoutes = require('./node-api-controller');

console.log('\n============ Startup Initiated ============');

const PORT = 80;
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const systemInfo = new SystemInfo();

function setNodeId() {
    const networkInfo = SystemInfo.getNetworkInfo();
    if (networkInfo.macAddress && networkInfo.macAddress !== 'Not available') {
        const lastThreeBytes = networkInfo.macAddress.split(':').slice(-3).join('').toUpperCase();
        return `node-${lastThreeBytes}`;
    }
    const tempId = Math.random().toString(16).slice(2, 5).toUpperCase();
    return `node-TMP${tempId}`;
}

const nodeId = setNodeId();
const mqttController = new MQTTController(nodeId);
const i2c = new I2C();
const sensors = {};

let configDb;
let dataDb;
let gpioController;

function getDataDbPath() {
    const hostname = os.hostname();
    return `./database/${hostname}-data.db`;
}

function createSensor(address, type) {
    const addrHex = address.startsWith('0x') ? parseInt(address, 16) : parseInt(address);
    switch(type) {
        case 'AHT10': return new AHT10(i2c, addrHex);
        case 'AHT20': return new AHT10(i2c, addrHex); // Using AHT10 driver for now
        default:
            console.warn(`Unknown sensor type: ${type}`);
            return null;
    }
}

function loadSensors() {
    return new Promise((resolve, reject) => {
        configDb.all('SELECT * FROM sensor_config WHERE enabled = 1', [], async (err, rows) => {
            if (err) {
                console.error('Error loading sensor configurations:', err);
                reject(err);
                return;
            }
            console.log(`Found ${rows.length} enabled sensors in database`);
            Object.keys(sensors).forEach(key => { delete sensors[key]; }); // Clear existing
            for (const row of rows) {
                try {
                    let address = row.address;
                    let type = row.type;
                    if (address.includes('-')) { // e.g., 0x38-AHT10
                        const parts = address.split('-');
                        address = parts[0];
                        type = parts[1] || type; // Use type from address if present
                    }
                    const sensor = createSensor(address, type);
                    if (sensor) {
                        sensors[address] = { instance: sensor, config: row, lastReading: null };
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

// Legacy sensors for backward compatibility
const sensor1 = new AHT10(i2c, 0x38);
const sensor2 = new AHT10(i2c, 0x39);

// Middleware for Express
app.use(express.static('public'));
app.use(express.json());

// UI Routes (remain in ug-node.js)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'node-index.html'));
});
app.get('/pwm', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pwm.html'));
});
app.get('/graph', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'graph.html'));
});
app.get('/schedule', (req, res) => {
    res.redirect('/pwm'); // Redirect schedule to pwm page for now
});

let shouldLogDatabase = false;

configDb = new sqlite3.Database('./database/ug-config.db', (err) => {
    if (err) {
        console.error('Error opening config database:', err);
        process.exit(1);
    }
    if (shouldLogDatabase) {
        console.log('Connected to config database');
    }
    configDb.serialize(() => {
        configDb.run(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, gpio INTEGER NOT NULL, time TEXT NOT NULL, pwm_value INTEGER NOT NULL, enabled INTEGER DEFAULT 1)`);
        
        configDb.run('INSERT OR IGNORE INTO safety_state (key, value) VALUES (?, 0)', ['emergency_stop']);
        configDb.run('INSERT OR IGNORE INTO safety_state (key, value) VALUES (?, 1)', ['normal_enable']);
        configDb.run('INSERT OR IGNORE INTO system_state (key, value) VALUES (?, 1)', ['mode']);

        // Add missing columns for threshold events (these will be ignored if columns already exist)
        configDb.run(`ALTER TABLE events ADD COLUMN trigger_type TEXT DEFAULT 'time'`, (err) => {
            if (err && !err.message.includes('duplicate column')) console.error('Error adding trigger_type column:', err);
        });
        configDb.run(`ALTER TABLE events ADD COLUMN sensor_address TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) console.error('Error adding sensor_address column:', err);
        });
        configDb.run(`ALTER TABLE events ADD COLUMN sensor_type TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) console.error('Error adding sensor_type column:', err);
        });
        configDb.run(`ALTER TABLE events ADD COLUMN threshold_condition TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) console.error('Error adding threshold_condition column:', err);
        });
        configDb.run(`ALTER TABLE events ADD COLUMN threshold_value REAL`, (err) => {
            if (err && !err.message.includes('duplicate column')) console.error('Error adding threshold_value column:', err);
        });
        configDb.run(`ALTER TABLE events ADD COLUMN cooldown_minutes INTEGER DEFAULT 5`, (err) => {
            if (err && !err.message.includes('duplicate column')) console.error('Error adding cooldown_minutes column:', err);
        });
        configDb.run(`ALTER TABLE events ADD COLUMN last_triggered_at DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) console.error('Error adding last_triggered_at column:', err);
        });
        configDb.run(`ALTER TABLE events ADD COLUMN priority INTEGER DEFAULT 1`, (err) => {
            if (err && !err.message.includes('duplicate column')) console.error('Error adding priority column:', err);
        });
        
        configDb.run(`CREATE TABLE IF NOT EXISTS manual_pwm_states (pin INTEGER PRIMARY KEY, value INTEGER DEFAULT 0, enabled INTEGER DEFAULT 0, last_modified DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        configDb.run(`CREATE TABLE IF NOT EXISTS auto_pwm_states (pin INTEGER PRIMARY KEY, value INTEGER DEFAULT 0, enabled INTEGER DEFAULT 0, last_modified DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        configDb.run(`CREATE TABLE IF NOT EXISTS sensor_config (
            address TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            name TEXT,
            enabled INTEGER DEFAULT 1,
            calibration_offset REAL DEFAULT 0.0,
            calibration_scale REAL DEFAULT 1.0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        configDb.run(`CREATE TABLE IF NOT EXISTS safety_state (key TEXT PRIMARY KEY, value INTEGER DEFAULT 0)`);
        configDb.run(`CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value INTEGER DEFAULT 1)`);
        configDb.run(`CREATE TABLE IF NOT EXISTS timezone (key TEXT PRIMARY KEY, value TEXT DEFAULT 'America/Los_Angeles')`);
        configDb.run(`CREATE TABLE IF NOT EXISTS sequence_tracker (key TEXT PRIMARY KEY, value INTEGER DEFAULT 0)`);
        configDb.run(`CREATE TABLE IF NOT EXISTS server_sync (server_id TEXT PRIMARY KEY, last_sync_time DATETIME, last_sequence INTEGER DEFAULT 0, last_seen DATETIME)`);
        configDb.run(`CREATE TABLE IF NOT EXISTS event_triggers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER,
            triggered_at DATETIME,
            gpio INTEGER,
            pwm_value INTEGER,
            trigger_type TEXT,
            sensor_address TEXT,
            sensor_value REAL,
            threshold_value REAL,
            FOREIGN KEY (event_id) REFERENCES events (id)
        )`);

        configDb.run('INSERT OR IGNORE INTO sequence_tracker (key, value) VALUES (?, ?)', ['last_sequence', 0]);
        configDb.run('INSERT OR IGNORE INTO timezone (key, value) VALUES (?, ?)', ['timezone', 'America/Los_Angeles']);

        const pins = [12, 13, 18, 19];
        pins.forEach(pin => {
            configDb.run('INSERT OR IGNORE INTO manual_pwm_states (pin, value, enabled) VALUES (?, 0, 0)', [pin]);
            configDb.run('INSERT OR IGNORE INTO auto_pwm_states (pin, value, enabled) VALUES (?, 0, 0)', [pin]);
        });
        configDb.run('INSERT OR IGNORE INTO safety_state (key, value) VALUES (?, 0)', ['emergency_stop']);
        configDb.run('INSERT OR IGNORE INTO safety_state (key, value) VALUES (?, 1)', ['normal_enable']);
        configDb.run('INSERT OR IGNORE INTO system_state (key, value) VALUES (?, 1)', ['mode']);
    });
});

dataDb = new sqlite3.Database(getDataDbPath(), (err) => {
    if (err) {
        console.error('Error opening data database:', err);
        process.exit(1);
    }
    if (shouldLogDatabase) {
        console.log('Connected to data database');
    }
    dataDb.serialize(() => {
        dataDb.run(`CREATE TABLE IF NOT EXISTS sensor_readings (
            timestamp DATETIME,
            address TEXT,
            type TEXT,
            value REAL,
            sequence_id INTEGER,
            PRIMARY KEY (timestamp, address, type)
        )`);
        dataDb.run(`CREATE INDEX IF NOT EXISTS idx_sequence_id ON sensor_readings(sequence_id)`);
        dataDb.run(`CREATE INDEX IF NOT EXISTS idx_address ON sensor_readings(address)`);
    });
    // Initialize SystemInfo with the database connection
    SystemInfo.setDataDb(dataDb);
});

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

function getDataBySequenceRange(startSequence, endSequence, limit = 1000) {
    // Cap the limit to 5000 records maximum
    const maxLimit = 5000;
    const actualLimit = Math.min(limit, maxLimit);
    
    return new Promise((resolve, reject) => {
        dataDb.all(
            `SELECT timestamp, address, type, value, sequence_id
             FROM sensor_readings
             WHERE sequence_id >= ? AND sequence_id <= ?
             ORDER BY sequence_id ASC
             LIMIT ?`,
            [startSequence, endSequence, actualLimit],
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

async function initAndRead() {
    try {
        // Initialize legacy sensors individually with better error handling
        let init1 = false;
        let init2 = false;
        
        try {
            init1 = await sensor1.initSensor();
            if (init1) {
                console.log('Legacy sensor 0x38 initialized successfully');
            } else {
                console.warn('Failed to initialize legacy sensor 0x38');
            }
        } catch (err) {
            console.error('Error initializing legacy sensor 0x38:', err.message);
        }
        
        try {
            init2 = await sensor2.initSensor();
            if (init2) {
                console.log('Legacy sensor 0x39 initialized successfully');
            } else {
                console.warn('Failed to initialize legacy sensor 0x39');
            }
        } catch (err) {
            console.error('Error initializing legacy sensor 0x39:', err.message);
        }
        
        if (!init1 && !init2) {
            console.error('Failed to initialize both legacy sensors - continuing with configured sensors only');
        }
        
        await loadSensors();
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

        setInterval(async () => {
            try {
                // Read legacy sensors individually with error handling
                let data1 = null;
                let data2 = null;
                
                if (init1) {
                    try {
                        data1 = await sensor1.readTemperatureAndHumidity();
                    } catch (err) {
                        console.error('Error reading legacy sensor 0x38:', err.message);
                    }
                }
                
                if (init2) {
                    try {
                        data2 = await sensor2.readTemperatureAndHumidity();
                    } catch (err) {
                        console.error('Error reading legacy sensor 0x39:', err.message);
                    }
                }
                
                const systemInfoData = await SystemInfo.getSystemInfo();

                const sensorReadings = {};
                const sensorReadPromises = [];
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
                await Promise.all(sensorReadPromises);

                // Process legacy sensors individually (don't require both)
                if (data1) {
                    try {
                        const seqId1 = await getNextSequenceId();
                        const seqId3 = await getNextSequenceId();
                        const timestamp = new Date().toISOString();
                        if (dataDb) {
                            dataDb.run('INSERT INTO sensor_readings (timestamp, address, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',[timestamp, '0x38', 'temperature', data1.temperature, seqId1]);
                            dataDb.run('INSERT INTO sensor_readings (timestamp, address, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',[timestamp, '0x38', 'humidity', data1.humidity, seqId3]);
                        }
                        // Update legacy sensor reading for threshold checking
                        if (!sensors['0x38']) {
                            sensors['0x38'] = { lastReading: data1, config: { calibration_scale: 1, calibration_offset: 0 } };
                        } else {
                            sensors['0x38'].lastReading = data1;
                        }
                    } catch (seqErr) {
                        console.error('Error getting sequence IDs for sensor 0x38:', seqErr);
                    }
                }

                if (data2) {
                    try {
                        const seqId2 = await getNextSequenceId();
                        const seqId4 = await getNextSequenceId();
                        const timestamp = new Date().toISOString();
                        if (dataDb) {
                            dataDb.run('INSERT INTO sensor_readings (timestamp, address, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',[timestamp, '0x39', 'temperature', data2.temperature, seqId2]);
                            dataDb.run('INSERT INTO sensor_readings (timestamp, address, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',[timestamp, '0x39', 'humidity', data2.humidity, seqId4]);
                        }
                        // Update legacy sensor reading for threshold checking
                        if (!sensors['0x39']) {
                            sensors['0x39'] = { lastReading: data2, config: { calibration_scale: 1, calibration_offset: 0 } };
                        } else {
                            sensors['0x39'].lastReading = data2;
                        }
                    } catch (seqErr) {
                        console.error('Error getting sequence IDs for sensor 0x39:', seqErr);
                    }
                }

                // Check threshold events for legacy sensors if any data was read
                if (data1 || data2) {
                    try {
                        await checkThresholdEvents();
                    } catch (thresholdErr) {
                        console.error('Error checking threshold events after legacy sensor reading:', thresholdErr);
                    }
                }

                for (const [address, data] of Object.entries(sensorReadings)) {
                    try {
                        const sensorConfig = sensors[address].config;
                        const tempSeqId = await getNextSequenceId();
                        const humiditySeqId = await getNextSequenceId();
                        const timestamp = new Date().toISOString();
                        if (dataDb) {
                            const tempValue = (data.temperature * (sensorConfig.calibration_scale || 1)) + (sensorConfig.calibration_offset || 0);
                            const humidityValue = data.humidity;
                            dataDb.run('INSERT INTO sensor_readings (timestamp, address, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',[timestamp, address, 'temperature', tempValue, tempSeqId]);
                            dataDb.run('INSERT INTO sensor_readings (timestamp, address, type, value, sequence_id) VALUES (?, ?, ?, ?, ?)',[timestamp, address, 'humidity', humidityValue, humiditySeqId]);
                        }
                    } catch (seqErr) {
                        console.error(`Error processing readings for sensor ${address}:`, seqErr);
                    }
                }

                // Check threshold events immediately after sensor readings are processed
                // This ensures safety-critical events (like overheating) are handled as soon as possible
                try {
                    await checkThresholdEvents();
                } catch (thresholdErr) {
                    console.error('Error checking threshold events after sensor reading:', thresholdErr);
                }

                if (configDb) {
                    configDb.get('SELECT value FROM timezone WHERE key = ?', ['timezone'], (err, row) => {
                        const databaseTimezone = err || !row ? 'America/Los_Angeles' : row.value;
                        const sensorDataForClients = {};
                        if (data1) sensorDataForClients['0x38'] = { ...data1, address: '0x38', temperature: `${data1.temperature.toFixed(1)}°F (${((data1.temperature - 32) * 5/9).toFixed(1)}°C)` };
                        if (data2) sensorDataForClients['0x39'] = { ...data2, address: '0x39', temperature: `${data2.temperature.toFixed(1)}°F (${((data2.temperature - 32) * 5/9).toFixed(1)}°C)` };
                        for (const [address, sensorObj] of Object.entries(sensors)) {
                            const reading = sensorObj.lastReading;
                            if (reading) {
                                const tempValue = (reading.temperature * (sensorObj.config.calibration_scale || 1)) + (sensorObj.config.calibration_offset || 0);
                                sensorDataForClients[address] = { 
                                    ...reading, 
                                    address: address, 
                                    temperature: `${tempValue.toFixed(1)}°F (${((tempValue - 32) * 5/9).toFixed(1)}°C)`, 
                                    raw_temperature: tempValue, 
                                    config: sensorObj.config 
                                };
                            }
                        }
                        if (io) io.emit('sensorData', { system: systemInfoData.system, databaseTimezone, ...sensorDataForClients });
                    });
                }
            } catch (error) {
                console.error('Error reading sensors:', error);
            }
        }, 10000);
    } catch (error) {
        console.error('Error initializing sensors:', error);
    }
}

// Sensor data is only published via MQTT when explicitly requested through data-get commands
// function publishSensorData(sensor1Data, sensor2Data, configuredSensorData = {}) {
//     mqttController.publishSensorData(sensor1Data, sensor2Data, configuredSensorData);
// }

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

function broadcastPWMState() {
    console.log('Server: Broadcasting PWM state...');
                Promise.all([
                new Promise((resolve) => configDb.all('SELECT pin, value, enabled FROM manual_pwm_states', [], (err, rows) => {
            if (err) { console.error('Server: Error fetching manual PWM states:', err); resolve({}); }
            else { const pwmStates = {}; rows.forEach(row => pwmStates[row.pin] = { value: row.value, enabled: row.enabled === 1 }); resolve(pwmStates); }
        })),
        new Promise((resolve) => configDb.all('SELECT pin, value, enabled FROM auto_pwm_states', [], (err, rows) => {
            if (err) { console.error('Server: Error fetching auto PWM states:', err); resolve({}); }
            else { const autoPwmStates = {}; rows.forEach(row => autoPwmStates[row.pin] = { value: row.value, enabled: row.enabled === 1 }); resolve(autoPwmStates); }
        })),
        new Promise((resolve) => configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
            if (err) { console.error('Server: Error getting mode:', err); resolve(1); } // Default manual
            else resolve(row ? row.value : 1);
        }))
    ]).then(([manualStates, autoStates, mode]) => {
        const currentStates = mode === 0 ? autoStates : manualStates;
        console.log('Server: Broadcasting PWM states:', { mode, current: currentStates, manual: manualStates, auto: autoStates });
        io.emit('pwmStateUpdate', { mode, current: currentStates, manual: manualStates, auto: autoStates });
    }).catch(err => console.error('Server: Error in broadcastPWMState:', err));
}

async function emergencyStop() {
    return new Promise((resolve) => configDb.run('UPDATE safety_state SET value = 1 WHERE key = ?', ['emergency_stop'], resolve));
}

async function clearEmergencyStop() {
    return new Promise((resolve) => configDb.run('UPDATE safety_state SET value = 0 WHERE key = ?', ['emergency_stop'], resolve));
}

async function checkThresholdEvents() {
    try {
        // Get all enabled threshold events
        const thresholdEvents = await new Promise((resolve, reject) => {
            configDb.all('SELECT * FROM events WHERE enabled = 1 AND trigger_type IN (?, ?)', 
                ['temperature', 'humidity'], (err, rows) => {
                if (err) reject(err); 
                else resolve(rows || []);
            });
        });

        if (thresholdEvents.length === 0) return;

        // Get current sensor readings
        const currentReadings = {};
        
        for (const [address, sensor] of Object.entries(sensors)) {
            if (sensor.lastReading && sensor.lastReading.temperature !== undefined && sensor.lastReading.humidity !== undefined) {
                // Apply calibration if configured
                const tempValue = (sensor.lastReading.temperature * (sensor.config.calibration_scale || 1)) + (sensor.config.calibration_offset || 0);
                currentReadings[address] = {
                    temperature: tempValue,
                    humidity: sensor.lastReading.humidity
                };
            }
        }

        const now = new Date();
        
        for (const event of thresholdEvents) {
            const sensorReading = currentReadings[event.sensor_address];
            if (!sensorReading) {
                continue; // Skip if no current reading for this sensor
            }

            // Check if event is in cooldown
            if (event.last_triggered_at) {
                const lastTriggered = new Date(event.last_triggered_at);
                const cooldownMs = (event.cooldown_minutes || 5) * 60 * 1000;
                const timeSinceLastTrigger = now.getTime() - lastTriggered.getTime();
                
                if (timeSinceLastTrigger < cooldownMs) {
                    continue; // Still in cooldown, skip this event
                }
            }

            // Get the current sensor value based on event type
            const currentValue = event.sensor_type === 'temperature' ? 
                sensorReading.temperature : sensorReading.humidity;
            
            if (currentValue === undefined || currentValue === null) {
                continue;
            }

            // Check if threshold condition is met
            let conditionMet = false;
            switch (event.threshold_condition) {
                case 'greater_than':
                case 'above':
                    conditionMet = currentValue > event.threshold_value;
                    break;
                case 'less_than':
                case 'below':
                    conditionMet = currentValue < event.threshold_value;
                    break;
                case 'equals':
                    conditionMet = Math.abs(currentValue - event.threshold_value) < 0.1;
                    break;
            }

            if (conditionMet) {
                console.log(`Threshold event triggered: GPIO${event.gpio} -> ${event.pwm_value} (${event.sensor_address} ${event.sensor_type} ${event.threshold_condition} ${event.threshold_value}, current: ${currentValue})`);
                
                // Update last triggered time
                await new Promise((resolve, reject) => {
                    configDb.run('UPDATE events SET last_triggered_at = ? WHERE id = ?', 
                        [now.toISOString(), event.id], (err) => {
                        if (err) reject(err); else resolve();
                    });
                });

                // Log the trigger event
                await new Promise((resolve, reject) => {
                    configDb.run(`INSERT INTO event_triggers 
                        (event_id, triggered_at, gpio, pwm_value, trigger_type, sensor_address, sensor_value, threshold_value) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
                        [event.id, now.toISOString(), event.gpio, event.pwm_value, event.sensor_type, 
                         event.sensor_address, currentValue, event.threshold_value], (err) => {
                        if (err) reject(err); else resolve();
                    });
                });

                // Apply PWM change if in automatic mode and system is safe
                const safetyStates = await new Promise((resolve, reject) => {
                    configDb.all('SELECT key, value FROM safety_state', [], (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows.reduce((acc, row) => { acc[row.key] = row.value; return acc; }, {}));
                    });
                });
                
                const mode = await new Promise((resolve, reject) => {
                    configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                        if (err) reject(err);
                        else resolve(row ? row.value : 1);
                    });
                });

                if (mode === 0 && safetyStates.emergency_stop !== 1 && safetyStates.normal_enable === 1) {
                    // Update auto PWM state
                    await new Promise((resolve, reject) => {
                        configDb.run('UPDATE auto_pwm_states SET value = ?, enabled = 1 WHERE pin = ?',
                            [event.pwm_value, event.gpio], (err) => {
                                if (err) reject(err); else resolve();
                            });
                    });

                    // Apply to hardware if GPIO controller is available
                    if (gpioController && gpioController.pwmEnabled && gpioController.pwmPins[event.gpio]) {
                        try {
                            const hardwareValue = Math.floor((event.pwm_value / 1023) * 255);
                            gpioController.pwmPins[event.gpio].pwmWrite(hardwareValue);
                            console.log(`Applied threshold event PWM: GPIO${event.gpio} = ${event.pwm_value} (hardware: ${hardwareValue})`);
                        } catch (error) {
                            console.error(`Error applying threshold event PWM to GPIO${event.gpio}:`, error);
                        }
                    }

                    // Broadcast PWM state update
                    broadcastPWMState();
                }
            }
        }
    } catch (error) {
        console.error('Error checking threshold events:', error);
    }
}

async function controlLoop() {
    try {
        const safetyStates = await new Promise((resolve, reject) => {
            configDb.all('SELECT key, value FROM safety_state', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.reduce((acc, row) => { acc[row.key] = row.value; return acc; }, {}));
            });
        });
        const mode = await new Promise((resolve, reject) => {
            configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.value : 1); // Default to manual mode
            });
        });

        let events = [];
        if (mode === 0 && safetyStates.emergency_stop !== 1 && safetyStates.normal_enable === 1) {
            // Get time-based events for GPIO controller
            events = await new Promise((resolve, reject) => {
                configDb.all('SELECT * FROM events WHERE enabled = 1 AND (trigger_type = ? OR trigger_type IS NULL) ORDER BY time', 
                    ['time'], (err, rows) => {
                    if (err) reject(err); else resolve(rows);
                });
            });
            
            // Check threshold events separately
            await checkThresholdEvents();
        }

        if (gpioController && gpioController.pwmEnabled) {
            await gpioController.updateHardwareForControlLoop(safetyStates, mode, events);
        }
    } catch (error) {
        console.error('Error in control loop:', error);
    }
}
setInterval(controlLoop, 1000);

async function publishNodeStatus() {
    try {
        // Only proceed if MQTT is connected
        if (!mqttController || !mqttController.getBrokerInfo().connected) {
            return; // Silently skip if MQTT isn't available
        }
        
        const systemInfoData = await SystemInfo.getSystemInfo();
        const safetyStates = await new Promise((resolve, reject) => {
            configDb.all('SELECT key, value FROM safety_state', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.reduce((acc, row) => { acc[row.key] = row.value === 1; return acc; }, {}));
            });
        });
        const mode = await new Promise((resolve, reject) => {
            configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.value : 1);
            });
        });

        let pwmStates = {};
        if (gpioController) {
            pwmStates = await gpioController.getPwmStatesForStatus();
        }

        const sequenceRangeData = await getSequenceRange();

        const sensorStatsData = await new Promise((resolve, reject) => {
            configDb.all('SELECT * FROM sensor_config', [], async (err, configuredSensors) => {
                if (err) {
                    console.error('Error fetching sensor_config for status:', err);
                    resolve({ sensors: [], totalRecordCount: 0 }); // Provide default on error
                    return;
                }
                const sensorsFromDb = configuredSensors || [];
                const allSensors = [
                    ...sensorsFromDb,
                    { address: '0x38', type: 'AHT10', name: 'Legacy AHT10 (0x38)' },
                    { address: '0x39', type: 'AHT10', name: 'Legacy AHT10 (0x39)' }
                ];
                const sensorStatsList = [];
                let totalRecordCount = 0;
                for (const sensor of allSensors) {
                    const address = sensor.address;
                    const tempCount = await new Promise((res) => dataDb.get('SELECT COUNT(*) as count FROM sensor_readings WHERE address = ? AND type = ?', [address, 'temperature'], (e, r) => res(e || !r ? 0 : r.count)));
                    const humidityCount = await new Promise((res) => dataDb.get('SELECT COUNT(*) as count FROM sensor_readings WHERE address = ? AND type = ?', [address, 'humidity'], (e, r) => res(e || !r ? 0 : r.count)));
                    const sensorTotal = tempCount + humidityCount;
                    totalRecordCount += sensorTotal;
                    sensorStatsList.push({ 
                        address: sensor.address, 
                        name: sensor.name || `${sensor.type} ${sensor.address}`, 
                        type: sensor.type, 
                        temperatureCount: tempCount, 
                        humidityCount: humidityCount, 
                        totalCount: sensorTotal 
                    });
                }
                resolve({ sensors: sensorStatsList, totalRecordCount });
            });
        });

        const networkInfo = SystemInfo.getNetworkInfo();
        const status = {
            node_id: nodeId,
            timestamp: new Date().toISOString(),
            hostname: os.hostname(),
            ip: networkInfo.ipAddress,
            system: { uptime: systemInfoData.system.piUptime, cpuTemp: systemInfoData.system.cpuTemp, internetConnected: systemInfoData.system.internetConnected },
            safety: safetyStates,
            mode: mode === 0 ? 'automatic' : 'manual',
            pwm: pwmStates,
            data: {
                sequenceRange: sequenceRangeData,
                sensorStats: sensorStatsData.sensors,
                totalRecords: sensorStatsData.totalRecordCount
            }
        };
        
        await mqttController.publishNodeStatus(status);
        return status; // Return the status in case caller needs it
    } catch (error) {
        console.error('Error publishing node status:', error);
        throw error; // Re-throw to allow caller to handle
    }
}

async function initializeMqtt() {
    try {
        const initialized = await mqttController.initialize();
        if (initialized) {
            mqttController.on('message', (topic, message) => {
                console.log(`Received message on ${topic}:`, message.toString());
                if (topic === `undergrowth/server/commands/${nodeId}/data/get`) {
                    try {
                        const request = JSON.parse(message.toString());
                        console.log(`Processing server data request:`, request.startSequence !== undefined ? `sequence-based (${request.startSequence} to ${request.endSequence || 'latest'})` : `time-based (${request.startTime} to ${request.endTime})`);
                        handleHistoryRequest(request);
                    } catch (error) {
                        console.error('Error handling data request:', error);
                    }
                } else if (topic === `undergrowth/server/commands/${nodeId}/info/get`) {
                    try {
                        console.log('Received info get request');
                        let request = {};
                        try {
                            // Try to parse the message as JSON, but don't fail if it's not valid
                            request = JSON.parse(message.toString());
                        } catch (parseError) {
                            console.log('Info request did not contain valid JSON, using empty object');
                        }
                        handleInfoGetRequest(request);
                    } catch (error) {
                        console.error('Error handling info get request:', error);
                    }
                }
            });
            
            // Subscribe to required Version 1.0 topics
            await mqttController.subscribe(`undergrowth/server/commands/${nodeId}/info/get`);
            await mqttController.subscribe(`undergrowth/server/commands/${nodeId}/data/get`);
            
            console.log('MQTT successfully initialized');
            
            return true;
        } else {
            console.log('MQTT initialization returned false. Node running in standalone mode.');
            return false;
        }
    } catch (error) {
        console.error('Error during MQTT initialization:', error);
        console.log('Continuing without MQTT support');
        
        // Schedule a retry after a delay
        setTimeout(() => {
            console.log('Retrying MQTT initialization...');
            initializeMqtt().catch(err => {
                console.error('MQTT retry failed:', err.message);
            });
        }, 300000); // Retry after 5 minutes
        
        return false;
    }
}

function handleHistoryRequest(request) {
    console.log('Received history request:', request);
    
    // Validate that request is a proper object
    if (!request || typeof request !== 'object') {
        console.error('Invalid history request: not a valid object');
        return;
    }
    
    // Check for required protocol version
    if (!request.protocol_version) {
        console.log('Warning: Missing protocol_version in request, assuming 1.0');
    }
    
    const isSequenceBased = request.startSequence !== undefined;
    if (isSequenceBased) {
        // Validate required fields for sequence-based requests
        if (!request.requestId) {
            console.error('Invalid sequence-based request, missing requestId');
            return;
        }
        
        if (request.startSequence === undefined) {
            console.error('Invalid sequence-based request, missing startSequence');
            return;
        }
        
        const startSequence = request.startSequence;
        const endSequence = request.endSequence || Number.MAX_SAFE_INTEGER;
        const limit = request.limit || 1000;
        getDataBySequenceRange(startSequence, endSequence, limit)
            .then(rows => getSequenceRange().then(sequenceRangeData => {
                // Convert to standardized format
                const dataPoints = rows.map(r => {
                    // Create standardized sensor_id format based on address
                    const sensorId = `aht10_${r.address}`;
                    // Add appropriate unit based on reading type
                    const unit = r.type === 'temperature' ? '°F' : '%';
                    
                    return {
                        timestamp: r.timestamp,
                        sensor_id: sensorId,
                        type: r.type,
                        value: r.value,
                        unit: unit,
                        sequence_id: r.sequence_id
                    };
                });
                
                const response = { 
                    nodeId: nodeId, 
                    timestamp: new Date().toISOString(),
                    requestId: request.requestId, 
                    startSequence: startSequence, 
                    endSequence: rows.length > 0 ? rows[rows.length - 1].sequence_id : startSequence, 
                    recordCount: rows.length,
                    data: rows.map(r => ({
                        timestamp: r.timestamp,
                        address: r.address,
                        type: r.type,
                        value: r.value,
                        sequence_id: r.sequence_id
                    }))
                };
                console.log(`Sending sequence-based history response with ${rows.length} records (max sequence: ${sequenceRangeData.maxSequence})`);
                
                // Use the updated publish API with the correct topic according to documentation
                mqttController.publish(`undergrowth/nodes/${nodeId}/responses/data/get`, response)
                    .then((result) => {
                        if (result.sent) {
                            const now = new Date().toISOString();
                            configDb.run('INSERT OR REPLACE INTO server_sync (server_id, last_sync_time, last_sequence, last_seen) VALUES (?, ?, ?, ?)', ['server', now, response.endSequence, now], (err) => {
                                if (err) console.error('Error updating server_sync table:', err);
                                else console.log(`Updated server sync record to sequence ${response.endSequence}`);
                            });
                        } else {
                            console.warn(`Failed to publish history response: ${result.reason}`);
                        }
                    });
            })).catch(err => {
                console.error('Error querying sequence-based sensor history:', err);
                // Use publish without throwing errors
                mqttController.publish(`undergrowth/nodes/${nodeId}/responses/data/get/error`, { 
                    node_id: nodeId, 
                    protocol_version: "1.0",
                    requestId: request.requestId, 
                    error: 'Database query error', 
                    message: err.message 
                });
            });
    } else { // Time-based request
        if (!request.startTime || !request.endTime || !request.requestId) {
            console.error('Invalid time-based request, missing required fields');
            return;
        }
        const query = `SELECT timestamp, address, type, value FROM sensor_readings WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`;
        dataDb.all(query, [request.startTime, request.endTime], (err, rows) => {
            if (err) {
                console.error('Error querying sensor history:', err);
                mqttController.publish(`undergrowth/nodes/${nodeId}/responses/data/get/error`, { 
                    node_id: nodeId, 
                    protocol_version: "1.0",
                    requestId: request.requestId, 
                    error: 'Database query error', 
                    message: err.message 
                });
                return;
            }
            getSequenceRange().then(sequenceRangeData => {
                // Convert to standardized format
                const dataPoints = rows.map(r => {
                    // Create standardized sensor_id format based on address
                    const sensorId = `aht10_${r.address}`;
                    // Add appropriate unit based on reading type
                    const unit = r.type === 'temperature' ? '°F' : '%';
                    
                    return {
                        timestamp: r.timestamp,
                        sensor_id: sensorId,
                        type: r.type,
                        value: r.value,
                        unit: unit
                    };
                });
                
                const response = { 
                    node_id: nodeId, 
                    requestId: request.requestId, 
                    startTime: request.startTime, 
                    endTime: request.endTime, 
                    maxSequence: sequenceRangeData.maxSequence, 
                    dataPoints: dataPoints, 
                    recordCount: rows.length 
                };
                console.log(`Sending time-based history response with ${rows.length} records (max sequence: ${sequenceRangeData.maxSequence})`);
                
                // Use the updated publish API with the correct topic according to documentation
                mqttController.publish(`undergrowth/nodes/${nodeId}/responses/data/get`, response)
                    .then((result) => {
                        if (result.sent) {
                            const now = new Date().toISOString();
                            configDb.run('INSERT OR REPLACE INTO server_sync (server_id, last_sync_time, last_seen) VALUES (?, ?, ?)', ['server', now, now], (err) => {
                                if (err) console.error('Error updating server_sync table:', err);
                            });
                        } else {
                            console.warn(`Failed to publish time-based history response: ${result.reason}`);
                        }
                    });
            }).catch(err => { // Fallback if getSequenceRange fails
                console.error('Error getting sequence range for time-based history:', err);
                
                // Convert to standardized format even in fallback case
                const dataPoints = rows.map(r => {
                    // Create standardized sensor_id format based on address
                    const sensorId = `aht10_${r.address}`;
                    // Add appropriate unit based on reading type
                    const unit = r.type === 'temperature' ? '°F' : '%';
                    
                    return {
                        timestamp: r.timestamp,
                        sensor_id: sensorId,
                        type: r.type,
                        value: r.value,
                        unit: unit
                    };
                });
                
                const response = { 
                    node_id: nodeId, 
                    requestId: request.requestId, 
                    startTime: request.startTime, 
                    endTime: request.endTime, 
                    dataPoints: dataPoints, 
                    recordCount: rows.length 
                };
                mqttController.publish(`undergrowth/nodes/${nodeId}/responses/data/get`, response);
            });
        });
    }
}

async function handleInfoGetRequest(request = {}) {
    try {
        // Check for protocol version in request
        if (request && !request.protocol_version) {
            console.log('Warning: Info request missing protocol_version, assuming 1.0');
        }
        
        // Get comprehensive node info from SystemInfo
        const infoResponse = await SystemInfo.getInfoResponse();
        
        // Publish info response to the correct topic according to the documentation
        await mqttController.publish(`undergrowth/nodes/${nodeId}/responses/info/get`, infoResponse);
        console.log('Published info response');
        
        // Also update SystemInfo's MQTT stats
        SystemInfo.updateMqttStats();
        
    } catch (error) {
        console.error('Error in handleInfoGetRequest:', error);
        // Send error response to the correct topic according to the documentation
        await mqttController.publish(`undergrowth/nodes/${nodeId}/responses/info/get/error`, {
            node_id: nodeId,
            protocol_version: "1.0",
            error: 'Failed to get node info',
            message: error.message
        });
    }
}

raspi.init(async () => {
    console.log(`Node ID: ${nodeId}`);
    console.log(`Startup Time: ${new Date().toISOString()}`);
    const networkInfo = SystemInfo.getNetworkInfo(); // Get network info early for logging

    console.log('\n------------------System Configuration-----------------');
    console.log(`Network Interface: ${networkInfo.interface || 'wlan0'}, IP: ${networkInfo.ipAddress}, MAC: ${networkInfo.macAddress}`);
    await SystemInfo.checkTimeSync();
    await SystemInfo.checkInternetConnectivity();
    await SystemInfo.getSystemTimezone();

    console.log('\n------------------Database Initialization-----------------');
    shouldLogDatabase = true;
    // Database connection logs are now within their respective sqlite3.Database callbacks

    gpioController = new GpioController(configDb, broadcastPWMState);
    initializeApiRoutes(app, configDb, dataDb); // Initialize API routes

    console.log('\n------------------Hardware Initialization-----------------');
    await gpioController.initialize();
    setTimeout(async () => {
        console.log('Applying saved PWM states to hardware from main...');
        if (gpioController) await gpioController.applyPwmStatesFromDb();
    }, 1000);

    console.log('\n------------------Sensor Initialization-----------------');
    await initAndRead();
    configDb.get('SELECT COUNT(*) as count FROM sensor_config', [], (err, row) => {
        if (err) {
            console.error('Error checking sensor config:', err);
            return;
        }
        if (row.count === 0) {
            console.log('No sensors configured, adding default AHT10 sensors');
            configDb.run('INSERT INTO sensor_config (address, type, name, enabled) VALUES (?, ?, ?, ?)', ['0x38-AHT10', 'AHT10', 'AHT10 Sensor 1', 1], (e) => { if (e) console.error('Error adding default sensor 1:', e); else console.log('Added default sensor 1 (0x38-AHT10)'); });
            configDb.run('INSERT INTO sensor_config (address, type, name, enabled) VALUES (?, ?, ?, ?)', ['0x39-AHT10', 'AHT10', 'AHT10 Sensor 2', 1], (e) => {
                if (e) console.error('Error adding default sensor 2:', e);
                else console.log('Added default sensor 2 (0x39-AHT10)');
                loadSensors().catch(le => console.error('Error loading sensors after adding defaults:', le));
            });
        }
    });

    console.log('\n------------------MQTT Configuration-----------------');
    try {
        const mqttInitialized = await initializeMqtt();
        if (mqttInitialized) console.log('MQTT successfully initialized (from main)');
        else console.log('MQTT initialization skipped. Node running in standalone mode (from main).');
    } catch (error) {
        console.error('Error during MQTT initialization (from main):', error);
        console.log('Continuing without MQTT support (from main)');
    }

    console.log('\n------------------Webserver Initialization-----------------');
    server.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
        console.log('\n========== Startup Complete ============');
        console.log(`Web UI accessible at: http://${networkInfo.ipAddress}:${PORT}`);
        console.log('\n========================================\n');
    });
});

function isSystemSafe() {
    return new Promise((resolve) => {
        configDb.get('SELECT value FROM safety_state WHERE key = ?', ['emergency_stop'], (err, row) => {
            if (err || !row) { console.error('Error checking emergency stop state:', err); resolve(false); return; }
            if (row.value === 1) { resolve(false); return; }
            configDb.get('SELECT value FROM safety_state WHERE key = ?', ['normal_enable'], (err, rowEnable) => {
                if (err || !rowEnable) { console.error('Error checking normal enable state:', err); resolve(false); return; }
                resolve(rowEnable.value === 1);
            });
        });
    });
}

async function toggleNormalEnable(enabled) {
    configDb.run('UPDATE safety_state SET value = ? WHERE key = ?', [enabled ? 1 : 0, 'normal_enable'], (err) => {
        if (err) {
            console.error("Error updating normal_enable state in DB:", err);
            return;
        }
        broadcastSafetyState();
    });
}

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
setInterval(emitBrokerInfo, 5000);

io.on('connection', (socket) => {
    console.log('Client connected');
    emitBrokerInfo();

    socket.on('getTimezone', () => {
        configDb.get('SELECT value FROM timezone WHERE key = ?', ['timezone'], (err, row) => {
            if (err) { console.error('Error getting timezone:', err); return; }
            socket.emit('timezoneUpdate', { timezone: row ? row.value : 'America/Los_Angeles' });
        });
    });

    socket.on('setTimezone', (data) => {
        configDb.run('UPDATE timezone SET value = ? WHERE key = ?', [data.timezone, 'timezone'], (err) => {
            if (err) { console.error('Error setting timezone:', err); return; }
            io.emit('timezoneUpdate', { timezone: data.timezone });
        });
    });

    socket.on('pwmSet', async (data) => {
        try {
            if (!gpioController) { socket.emit('pwmError', { pin: data.pin, message: 'GPIO system not ready.', blocked: true }); return; }
            await gpioController.setPWM(data.pin, data.value, socket);
        } catch (error) {
            console.error('Error in pwmSet socket handler:', error);
            socket.emit('pwmError', { pin: data.pin, message: 'Server error: ' + error.message, blocked: false });
        }
    });

    socket.on('pwmToggle', async (data) => {
        try {
            if (!gpioController) { socket.emit('pwmError', { pin: data.pin, message: 'GPIO system not ready.', blocked: true }); return; }
            await gpioController.togglePWM(data.pin, data.enabled, socket);
        } catch (error) {
            console.error('Error in pwmToggle socket handler:', error);
            socket.emit('pwmError', { pin: data.pin, message: 'Server error: ' + error.message, blocked: false });
        }
    });

    socket.on('setMode', async (data) => {
        try {
            const mode = data.automatic ? 0 : 1;
            console.log(`Setting mode to ${data.automatic ? 'automatic' : 'manual'} (${mode})`);
            configDb.run('UPDATE system_state SET value = ? WHERE key = ?', [mode, 'mode'], async (err) => {
                if (err) { console.error('Error updating mode in database:', err); return; }
                io.emit('modeUpdate', { mode });
                broadcastPWMState();
                if (gpioController && mode === 0) {
                    await controlLoop();
                } else if (gpioController && mode === 1) {
                    await gpioController.applyPwmStatesFromDb();
                }
            });
        } catch (error) { console.error('Error in setMode handler:', error); }
    });

    socket.on('getInitialState', async () => {
        try {
            const safetyStatesDb = await new Promise((resolve) => configDb.all('SELECT key,value FROM safety_state',[],(e,r)=>resolve(e?{}:r.reduce((acc,rw)=>{acc[rw.key]=rw.value;return acc;},{}))));
            const mode = await new Promise((resolve) => configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (e,r)=>resolve(e||!r?1:r.value)));
            const manualPwmStates = await new Promise((resolve) => configDb.all('SELECT pin,value,enabled FROM manual_pwm_states',[],(e,r)=>resolve(e?{}:r.reduce((acc,rw)=>{acc[rw.pin]={value:rw.value,enabled:rw.enabled===1};return acc;},{}))));
            const autoPwmStates = await new Promise((resolve) => configDb.all('SELECT pin,value,enabled FROM auto_pwm_states',[],(e,r)=>resolve(e?{}:r.reduce((acc,rw)=>{acc[rw.pin]={value:rw.value,enabled:rw.enabled===1};return acc;},{}))));
            
            socket.emit('initialState', {
                safety: { emergency_stop: safetyStatesDb.emergency_stop === 1, normal_enable: safetyStatesDb.normal_enable === 1 },
                mode,
                pwmStates: { mode, current: mode === 0 ? autoPwmStates : manualPwmStates, manual: manualPwmStates, auto: autoPwmStates }
            });
            configDb.all('SELECT * FROM events ORDER BY time, threshold_value', [], (err, rows) => {
                if (err) { console.error('Error getting events for initial state:', err); return; }
                if (rows && rows.length > 0) socket.emit('eventsUpdated', rows);
            });
        } catch (error) { console.error('Error in getInitialState handler:', error); }
    });

    socket.on('applyPwmHardware', async () => {
        console.log('Manual request to apply PWM hardware state received');
        if (gpioController) await gpioController.applyPwmStatesFromDb();
    });

    socket.on('getEvents', () => {
        configDb.all('SELECT * FROM events ORDER BY time, threshold_value', [], (err, rows) => {
            if (err) { console.error('Error getting events:', err); socket.emit('error', { message: 'Failed to retrieve events' }); return; }
            socket.emit('eventsUpdated', rows);
        });
    });

    socket.on('addEvent', (data) => {
        const { gpio, time, pwm_value, enabled, trigger_type, sensor_address, sensor_type, threshold_condition, threshold_value, cooldown_minutes, priority } = data;
        
        // Validate required fields
        if (!gpio || pwm_value === undefined) { 
            socket.emit('error', { message: 'Invalid event data: gpio and pwm_value are required' }); 
            return; 
        }
        
        // For time events, time is required
        if ((!trigger_type || trigger_type === 'time') && !time) {
            socket.emit('error', { message: 'Invalid event data: time is required for time-based events' }); 
            return;
        }
        
        // For threshold events, validate threshold fields
        if (trigger_type && trigger_type !== 'time') {
            if (!sensor_address || !sensor_type || !threshold_condition || threshold_value === undefined) {
                socket.emit('error', { message: 'Invalid event data: threshold events require sensor_address, sensor_type, threshold_condition, and threshold_value' }); 
                return;
            }
        }
        
        // Insert event with all fields including priority
        const sql = `INSERT INTO events 
            (gpio, time, pwm_value, enabled, trigger_type, sensor_address, sensor_type, threshold_condition, threshold_value, cooldown_minutes, priority) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        
        const params = [
            gpio, 
            time || '', 
            pwm_value, 
            enabled === undefined ? 1 : (enabled ? 1 : 0),
            trigger_type || 'time',
            sensor_address || null,
            sensor_type || null,
            threshold_condition || null,
            threshold_value || null,
            cooldown_minutes || null,
            priority || 1
        ];
        
        configDb.run(sql, params, function (err) {
            if (err) { 
                console.error('Error adding event:', err); 
                socket.emit('error', { message: 'Failed to add event: ' + err.message }); 
                return; 
            }
            
            if (trigger_type && trigger_type !== 'time') {
                console.log(`Threshold event added: GPIO${gpio} -> ${pwm_value} when ${sensor_address} ${sensor_type} ${threshold_condition} ${threshold_value} (priority: ${priority || 1}, cooldown: ${cooldown_minutes || 5}min)`);
            } else {
                console.log(`Time event added: GPIO${gpio} at ${time} with PWM ${pwm_value} (priority: ${priority || 1})`);
            }
            
            // Return updated events list with all columns for threshold events
            configDb.all('SELECT * FROM events ORDER BY time, threshold_value', [], (e, r) => { 
                if (e) console.error('Error getting events after add:', e); 
                else io.emit('eventsUpdated', r); 
            });
        });
    });

    socket.on('deleteEvent', (data) => {
        console.log('Server received deleteEvent request:', data); // Debug log
        const { id } = data;
        if (!id) { 
            console.log('Error: Invalid event ID'); // Debug log
            socket.emit('error', { message: 'Invalid event ID' }); 
            return; 
        }
        configDb.run('DELETE FROM events WHERE id = ?', [id], function (err) {
            if (err) { 
                console.error('Error deleting event:', err); 
                socket.emit('error', { message: 'Failed to delete event' }); 
                return; 
            }
            console.log(`Event ${id} deleted successfully`); // Enhanced debug log
            configDb.all('SELECT * FROM events ORDER BY time, threshold_value', [], (e, r) => { 
                if (e) console.error('Error getting events after delete:', e); 
                else {
                    console.log('Broadcasting updated events list'); // Debug log
                    io.emit('eventsUpdated', r); 
                }
            });
        });
    });

    socket.on('toggleEvent', (data) => {
        const { id, enabled } = data;
        if (!id || enabled === undefined) { socket.emit('error', { message: 'Invalid event data' }); return; }
        configDb.run('UPDATE events SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id], function (err) {
            if (err) { console.error('Error toggling event:', err); socket.emit('error', { message: 'Failed to toggle event' }); return; }
            console.log(`Event ${id} toggled to ${enabled ? 'enabled' : 'disabled'}`);
            configDb.all('SELECT * FROM events ORDER BY time, threshold_value', [], (e, r) => { if (e) console.error('Error getting events after toggle:', e); else io.emit('eventsUpdated', r); });
        });
    });

    socket.on('emergencyStop', async () => {
        console.log('Emergency stop requested');
        try {
            await emergencyStop();
            broadcastSafetyState();
            if (gpioController) gpioController.emergencyStopOutputs();
        } catch (error) { console.error('Error in emergencyStop handler:', error); }
    });

    socket.on('clearEmergencyStop', async () => {
        console.log('Clear emergency stop requested');
        try {
            await clearEmergencyStop();
            broadcastSafetyState();
            if (gpioController) await gpioController.clearEmergencyStopOutputs();
        } catch (error) { console.error('Error in clearEmergencyStop handler:', error); }
    });

    socket.on('toggleNormalEnable', async (data) => {
        const enabled = data.enabled;
        console.log(`Toggle Normal Enable request: ${enabled}`);
        await toggleNormalEnable(enabled); // This updates DB and calls broadcastSafetyState
        if (gpioController) {
            const isSafeNow = await isSystemSafe(); // Re-check overall safety
            if (isSafeNow) { // If system is safe (E-Stop OFF, Normal Enable ON)
                await gpioController.applyPwmStatesFromDb();
            } else { // If not safe (E-Stop ON, or Normal Enable OFF)
                gpioController.emergencyStopOutputs();
            }
        }
    });

    socket.on('triggerEvent', async (data) => {
        console.log('Manual trigger event request:', data);
        const { id } = data;
        
        if (!id) {
            socket.emit('error', { message: 'Invalid event ID' });
            return;
        }
        
        // Get the event details
        configDb.get('SELECT * FROM events WHERE id = ?', [id], async (err, event) => {
            if (err) {
                console.error('Error getting event for manual trigger:', err);
                socket.emit('error', { message: 'Failed to get event details' });
                return;
            }
            
            if (!event) {
                socket.emit('error', { message: 'Event not found' });
                return;
            }
            
            // Only allow manual triggering of threshold events
            if (event.trigger_type === 'time' || !event.trigger_type) {
                socket.emit('error', { message: 'Cannot manually trigger time-based events' });
                return;
            }
            
            console.log(`Manually triggering threshold event ${id}: GPIO${event.gpio} -> ${event.pwm_value}`);
            
            // Check if event is in cooldown
            if (event.last_triggered_at) {
                const lastTriggered = new Date(event.last_triggered_at);
                const cooldownMs = (event.cooldown_minutes || 5) * 60 * 1000;
                const timeLeft = cooldownMs - (Date.now() - lastTriggered.getTime());
                
                if (timeLeft > 0) {
                    const minutesLeft = Math.ceil(timeLeft / 60000);
                    socket.emit('error', { message: `Event is in cooldown for ${minutesLeft} more minutes` });
                    return;
                }
            }
            
            // Trigger the event (same logic as threshold checking)
            try {
                // Update auto PWM state in database first
                await new Promise((resolve, reject) => {
                    configDb.run('UPDATE auto_pwm_states SET value = ?, enabled = 1 WHERE pin = ?',
                        [event.pwm_value, event.gpio], (err) => {
                            if (err) reject(err); else resolve();
                        });
                });

                // Apply to hardware directly (bypass setPWM which blocks in automatic mode)
                if (gpioController && gpioController.pwmEnabled && gpioController.pwmPins[event.gpio]) {
                    const hardwareValue = Math.floor((event.pwm_value / 1023) * 255);
                    try {
                        gpioController.pwmPins[event.gpio].pwmWrite(hardwareValue);
                        console.log(`Manual trigger successful: GPIO${event.gpio} set to ${event.pwm_value} (hardware: ${hardwareValue})`);
                    } catch (e) {
                        console.error(`Error setting PWM hardware for GPIO${event.gpio}:`, e.message);
                    }
                }
                
                // Update last triggered time
                const now = new Date().toISOString();
                configDb.run('UPDATE events SET last_triggered_at = ? WHERE id = ?', [now, id], (updateErr) => {
                    if (updateErr) {
                        console.error('Error updating last_triggered_at:', updateErr);
                    } else {
                        console.log(`Updated last_triggered_at for event ${id}`);
                        
                        // Broadcast PWM state update
                        broadcastPWMState();
                        
                        // Broadcast updated events list
                        configDb.all('SELECT * FROM events ORDER BY time, threshold_value', [], (e, r) => {
                            if (!e && r) {
                                io.emit('eventsUpdated', r);
                            }
                        });
                    }
                });
                
                socket.emit('success', { message: `Event triggered successfully: GPIO${event.gpio} -> ${event.pwm_value}` });
                
            } catch (error) {
                console.error('Error during manual trigger:', error);
                socket.emit('error', { message: 'Failed to trigger event' });
            }
        });
    });

    socket.on('resetCooldown', (data) => {
        console.log('Reset cooldown request:', data);
        const { id } = data;
        
        if (!id) {
            socket.emit('error', { message: 'Invalid event ID' });
            return;
        }
        
        // Clear the last_triggered_at timestamp
        configDb.run('UPDATE events SET last_triggered_at = NULL WHERE id = ?', [id], function (err) {
            if (err) {
                console.error('Error resetting cooldown:', err);
                socket.emit('error', { message: 'Failed to reset cooldown' });
                return;
            }
            
            console.log(`Cooldown reset for event ${id}`);
            
            // Broadcast updated events list
            configDb.all('SELECT * FROM events ORDER BY time, threshold_value', [], (e, r) => {
                if (!e && r) {
                    io.emit('eventsUpdated', r);
                }
            });
            
            socket.emit('success', { message: 'Cooldown reset successfully' });
        });
    });
});

// Export dataDb for other modules
module.exports = {
    dataDb: dataDb
};