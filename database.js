/**
 * Database module for Undergrowth Node
 * Handles all database interactions for configuration and sensor data
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

class DatabaseController extends EventEmitter {
    constructor() {
        super();
        this.configDb = null;
        this.dataDb = null;
        this.shouldLogDatabase = false;
        this.currentSequenceId = 0;
        this.isInitialized = false;
    }

    /**
     * Initialize the database connections and create tables if needed
     * @param {boolean} enableLogging - Enable logging of database operations
     * @returns {Promise} - Resolves when databases are initialized
     */
    async initialize(enableLogging = false) {
        this.shouldLogDatabase = enableLogging;
        
        if (this.isInitialized) {
            return Promise.resolve();
        }
        
        // Ensure data directory exists
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        // Initialize config database
        const configDbPath = path.join(dataDir, 'ug-config.db');
        const configExists = fs.existsSync(configDbPath);
        
        // Initialize data database
        const dataDbPath = path.join(dataDir, 'ug-data.db');
        const dataExists = fs.existsSync(dataDbPath);
        
        return new Promise((resolve, reject) => {
            try {
                // Open or create config database
                this.configDb = new sqlite3.Database(configDbPath, (err) => {
                    if (err) {
                        console.error('Error opening config database:', err);
                        reject(err);
                        return;
                    }
                    
                    if (this.shouldLogDatabase) {
                        console.log('Connected to config database');
                    }
                    
                    // Open or create data database
                    this.dataDb = new sqlite3.Database(dataDbPath, (err) => {
                        if (err) {
                            console.error('Error opening data database:', err);
                            reject(err);
                            return;
                        }
                        
                        if (this.shouldLogDatabase) {
                            console.log('Connected to data database');
                        }
                        
                        // Initialize database schema
                        this._initConfig(configExists)
                            .then(() => this._initData(dataExists))
                            .then(() => {
                                this.isInitialized = true;
                                resolve();
                            })
                            .catch(err => {
                                console.error('Error initializing database schema:', err);
                                reject(err);
                            });
                    });
                });
            } catch (error) {
                console.error('Error initializing databases:', error);
                reject(error);
            }
        });
    }
    
    /**
     * Initialize config database schema
     * @param {boolean} exists - Whether the database file already exists
     * @returns {Promise} - Resolves when schema is initialized
     */
    _initConfig(exists) {
        return new Promise((resolve, reject) => {
            if (!exists) {
                if (this.shouldLogDatabase) {
                    console.log('Creating config database schema');
                }
                
                // Enable foreign keys
                this.configDb.run('PRAGMA foreign_keys = ON', (err) => {
                    if (err) {
                        console.error('Error enabling foreign keys in config database:', err);
                        reject(err);
                        return;
                    }
                    
                    // Create tables
                    const createTables = [
                        // Safety state table
                        `CREATE TABLE IF NOT EXISTS safety_state (
                            key TEXT PRIMARY KEY,
                            value INTEGER NOT NULL
                        )`,
                        
                        // System state table
                        `CREATE TABLE IF NOT EXISTS system_state (
                            key TEXT PRIMARY KEY,
                            value INTEGER NOT NULL
                        )`,
                        
                        // Timezone table
                        `CREATE TABLE IF NOT EXISTS timezone (
                            key TEXT PRIMARY KEY,
                            value TEXT NOT NULL
                        )`,
                        
                        // PWM states table
                        `CREATE TABLE IF NOT EXISTS pwm_states (
                            pin INTEGER PRIMARY KEY,
                            value INTEGER NOT NULL,
                            enabled INTEGER NOT NULL
                        )`,
                        
                        // Auto PWM states table
                        `CREATE TABLE IF NOT EXISTS auto_pwm_states (
                            pin INTEGER PRIMARY KEY,
                            value INTEGER NOT NULL,
                            enabled INTEGER NOT NULL
                        )`,
                        
                        // Schedule events table
                        `CREATE TABLE IF NOT EXISTS events (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            gpio INTEGER NOT NULL,
                            time TEXT NOT NULL,
                            pwm_value INTEGER NOT NULL,
                            enabled INTEGER NOT NULL DEFAULT 1,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        )`,
                        
                        // Sensor configurations table
                        `CREATE TABLE IF NOT EXISTS sensor_config (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            address TEXT NOT NULL,
                            type TEXT NOT NULL,
                            name TEXT,
                            enabled INTEGER NOT NULL DEFAULT 1,
                            calibration_offset REAL DEFAULT 0.0,
                            calibration_scale REAL DEFAULT 1.0,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        )`,
                        
                        // Sequence table for tracking data sequences
                        `CREATE TABLE IF NOT EXISTS sequence (
                            id INTEGER PRIMARY KEY,
                            current_sequence INTEGER NOT NULL DEFAULT 0,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        )`,
                        
                        // Server sync tracking table
                        `CREATE TABLE IF NOT EXISTS server_sync (
                            server_id TEXT PRIMARY KEY,
                            last_sync_time TIMESTAMP,
                            last_sequence INTEGER,
                            sent_count INTEGER DEFAULT 0,
                            last_seen TIMESTAMP
                        )`
                    ];
                    
                    // Execute each CREATE TABLE statement
                    let completed = 0;
                    createTables.forEach(sql => {
                        this.configDb.run(sql, (err) => {
                            if (err) {
                                console.error('Error creating config table:', err);
                                reject(err);
                                return;
                            }
                            
                            completed++;
                            if (completed === createTables.length) {
                                // Insert default data
                                this._initDefaultConfigData()
                                    .then(resolve)
                                    .catch(reject);
                            }
                        });
                    });
                });
            } else {
                // Database already exists, resolve immediately
                resolve();
            }
        });
    }
    
    /**
     * Initialize data database schema
     * @param {boolean} exists - Whether the database file already exists
     * @returns {Promise} - Resolves when schema is initialized
     */
    _initData(exists) {
        return new Promise((resolve, reject) => {
            if (!exists) {
                if (this.shouldLogDatabase) {
                    console.log('Creating data database schema');
                }
                
                // Enable foreign keys
                this.dataDb.run('PRAGMA foreign_keys = ON', (err) => {
                    if (err) {
                        console.error('Error enabling foreign keys in data database:', err);
                        reject(err);
                        return;
                    }
                    
                    // Create sensor readings table
                    const sql = `CREATE TABLE IF NOT EXISTS sensor_readings (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        sequence_id INTEGER NOT NULL,
                        device_id TEXT NOT NULL,
                        type TEXT NOT NULL,
                        value REAL,
                        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )`;
                    
                    this.dataDb.run(sql, (err) => {
                        if (err) {
                            console.error('Error creating sensor_readings table:', err);
                            reject(err);
                            return;
                        }
                        
                        // Create indices for faster queries
                        const createIndices = [
                            `CREATE INDEX IF NOT EXISTS idx_sequence_id 
                             ON sensor_readings (sequence_id)`,
                            `CREATE INDEX IF NOT EXISTS idx_timestamp 
                             ON sensor_readings (timestamp)`,
                            `CREATE INDEX IF NOT EXISTS idx_device_type 
                             ON sensor_readings (device_id, type)`,
                            `CREATE INDEX IF NOT EXISTS idx_readings_combined 
                             ON sensor_readings (device_id, type, timestamp)`
                        ];
                        
                        let completed = 0;
                        createIndices.forEach(sql => {
                            this.dataDb.run(sql, (err) => {
                                if (err) {
                                    console.error('Error creating index:', err);
                                    reject(err);
                                    return;
                                }
                                
                                completed++;
                                if (completed === createIndices.length) {
                                    resolve();
                                }
                            });
                        });
                    });
                });
            } else {
                // Database already exists, resolve immediately
                resolve();
            }
        });
    }
    
    /**
     * Initialize default configuration data
     * @returns {Promise} - Resolves when default data is inserted
     */
    _initDefaultConfigData() {
        return new Promise((resolve, reject) => {
            // Insert default safety states
            const defaultSafetyStates = [
                { key: 'emergency_stop', value: 0 },
                { key: 'normal_enable', value: 1 }
            ];
            
            defaultSafetyStates.forEach(state => {
                this.configDb.run(
                    'INSERT OR IGNORE INTO safety_state (key, value) VALUES (?, ?)',
                    [state.key, state.value],
                    (err) => {
                        if (err) {
                            console.error(`Error inserting default safety state ${state.key}:`, err);
                            // Don't reject, continue with other inserts
                        }
                    }
                );
            });
            
            // Insert default system states
            const defaultSystemStates = [
                { key: 'mode', value: 1 } // 1 = manual mode, 0 = automatic mode
            ];
            
            defaultSystemStates.forEach(state => {
                this.configDb.run(
                    'INSERT OR IGNORE INTO system_state (key, value) VALUES (?, ?)',
                    [state.key, state.value],
                    (err) => {
                        if (err) {
                            console.error(`Error inserting default system state ${state.key}:`, err);
                            // Don't reject, continue with other inserts
                        }
                    }
                );
            });
            
            // Insert default timezone
            this.configDb.run(
                'INSERT OR IGNORE INTO timezone (key, value) VALUES (?, ?)',
                ['timezone', 'America/Los_Angeles'],
                (err) => {
                    if (err) {
                        console.error('Error inserting default timezone:', err);
                        // Don't reject, continue with other inserts
                    }
                }
            );
            
            // Insert default PWM states for common pins
            const defaultPins = [12, 13, 18, 19]; // Common GPIO pins for PWM
            let completedPins = 0;
            
            defaultPins.forEach(pin => {
                // Insert default manual PWM state
                this.configDb.run(
                    'INSERT OR IGNORE INTO pwm_states (pin, value, enabled) VALUES (?, ?, ?)',
                    [pin, 0, 0],
                    (err) => {
                        if (err) {
                            console.error(`Error inserting default PWM state for pin ${pin}:`, err);
                            // Don't reject, continue with other inserts
                        }
                        
                        // Insert default auto PWM state
                        this.configDb.run(
                            'INSERT OR IGNORE INTO auto_pwm_states (pin, value, enabled) VALUES (?, ?, ?)',
                            [pin, 0, 0],
                            (err) => {
                                if (err) {
                                    console.error(`Error inserting default auto PWM state for pin ${pin}:`, err);
                                    // Don't reject, continue with other inserts
                                }
                                
                                completedPins++;
                                if (completedPins === defaultPins.length) {
                                    // Insert initial sequence record
                                    this.configDb.run(
                                        'INSERT OR IGNORE INTO sequence (id, current_sequence) VALUES (?, ?)',
                                        [1, 0],
                                        (err) => {
                                            if (err) {
                                                console.error('Error inserting initial sequence:', err);
                                                reject(err);
                                                return;
                                            }
                                            
                                            resolve();
                                        }
                                    );
                                }
                            }
                        );
                    }
                );
            });
        });
    }
    
    /**
     * Get the next sequence ID for sensor readings
     * @returns {Promise<number>} - Resolves with the next sequence ID
     */
    async getNextSequenceId() {
        return new Promise((resolve, reject) => {
            this.configDb.get('SELECT current_sequence FROM sequence WHERE id = 1', [], (err, row) => {
                if (err) {
                    console.error('Error getting current sequence:', err);
                    reject(err);
                    return;
                }
                
                // If no record found, create one
                if (!row) {
                    this.configDb.run(
                        'INSERT INTO sequence (id, current_sequence) VALUES (?, ?)',
                        [1, 0],
                        (err) => {
                            if (err) {
                                console.error('Error creating sequence record:', err);
                                reject(err);
                                return;
                            }
                            
                            this.currentSequenceId = 1;
                            resolve(1);
                        }
                    );
                    return;
                }
                
                // Increment the sequence
                const nextSequence = (row.current_sequence || 0) + 1;
                this.configDb.run(
                    'UPDATE sequence SET current_sequence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
                    [nextSequence],
                    (err) => {
                        if (err) {
                            console.error('Error updating sequence:', err);
                            reject(err);
                            return;
                        }
                        
                        this.currentSequenceId = nextSequence;
                        resolve(nextSequence);
                    }
                );
            });
        });
    }
    
    /**
     * Get the current sequence range (min/max)
     * @returns {Promise<Object>} - Resolves with the sequence range
     */
    async getSequenceRange() {
        return new Promise((resolve, reject) => {
            // Get the min sequence
            this.dataDb.get(
                'SELECT MIN(sequence_id) as minSequence FROM sensor_readings',
                [],
                (err, minRow) => {
                    if (err) {
                        console.error('Error getting min sequence:', err);
                        reject(err);
                        return;
                    }
                    
                    // Get the max sequence
                    this.dataDb.get(
                        'SELECT MAX(sequence_id) as maxSequence FROM sensor_readings',
                        [],
                        (err, maxRow) => {
                            if (err) {
                                console.error('Error getting max sequence:', err);
                                reject(err);
                                return;
                            }
                            
                            // Get the count of records
                            this.dataDb.get(
                                'SELECT COUNT(*) as count FROM sensor_readings',
                                [],
                                (err, countRow) => {
                                    if (err) {
                                        console.error('Error getting record count:', err);
                                        reject(err);
                                        return;
                                    }
                                    
                                    resolve({
                                        minSequence: minRow ? minRow.minSequence || 0 : 0,
                                        maxSequence: maxRow ? maxRow.maxSequence || 0 : 0,
                                        count: countRow ? countRow.count || 0 : 0
                                    });
                                }
                            );
                        }
                    );
                }
            );
        });
    }
    
    /**
     * Get data by sequence range
     * @param {number} startSequence - Start sequence ID
     * @param {number} endSequence - End sequence ID
     * @param {number} limit - Maximum number of records to return
     * @returns {Promise<Array>} - Resolves with an array of readings
     */
    async getDataBySequenceRange(startSequence, endSequence, limit = 1000) {
        return new Promise((resolve, reject) => {
            this.dataDb.all(
                `SELECT sequence_id, device_id, type, value, timestamp
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
    
    /**
     * Get data by time range
     * @param {string} startTime - Start time in ISO format
     * @param {string} endTime - End time in ISO format
     * @param {number} limit - Maximum number of records to return
     * @returns {Promise<Array>} - Resolves with an array of readings
     */
    async getDataByTimeRange(startTime, endTime, limit = 1000) {
        return new Promise((resolve, reject) => {
            this.dataDb.all(
                `SELECT sequence_id, device_id, type, value, timestamp
                FROM sensor_readings
                WHERE timestamp >= ? AND timestamp <= ?
                ORDER BY timestamp ASC
                LIMIT ?`,
                [startTime, endTime, limit],
                (err, rows) => {
                    if (err) {
                        console.error('Error getting data by time range:', err);
                        reject(err);
                        return;
                    }
                    
                    resolve(rows);
                }
            );
        });
    }
    
    /**
     * Get binned sensor readings for charting
     * @param {string} startDate - Start date in ISO format
     * @param {number} hours - Number of hours to include
     * @param {number} binCount - Number of bins
     * @param {string} type - Reading type (temperature or humidity)
     * @param {Array<string>} sensors - Array of sensor IDs to include
     * @param {boolean} showAverage - Whether to show average across sensors
     * @returns {Promise<Array>} - Resolves with an array of binned readings
     */
    async getBinnedReadings(startDate, hours, binCount, type, sensors = null, showAverage = false) {
        return new Promise((resolve, reject) => {
            // Convert startDate to numeric epoch
            const startMs = Date.parse(startDate);
            if (isNaN(startMs)) {
                reject(new Error('Invalid startDate format'));
                return;
            }
            
            const endMs = startMs + (hours * 3600 * 1000); // add X hours in ms
            
            // Convert to ISO for DB query
            const startIso = new Date(startMs).toISOString();
            const endIso = new Date(endMs).toISOString();
            
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
            
            // Fetch raw rows from DB
            this.dataDb.all(sql, params, (err, rawRows) => {
                if (err) {
                    console.error('Error getting binned readings:', err);
                    reject(err);
                    return;
                }
                
                if (!rawRows || rawRows.length === 0) {
                    resolve([]); // No data in that range
                    return;
                }
                
                // If showing average across all sensors
                if (showAverage) {
                    // Create bins
                    const bins = new Array(binCount).fill(null).map(() => ({ sum: 0, count: 0 }));
                    const totalMs = endMs - startMs;
                    const binSizeMs = totalMs / binCount; // ms per bin
                    
                    // Distribute each raw row into the correct bin
                    for (const row of rawRows) {
                        const tMs = Date.parse(row.timestamp);
                        const offset = tMs - startMs; // ms since start
                        const index = Math.floor(offset / binSizeMs);
                        if (index >= 0 && index < binCount) {
                            bins[index].sum += row.value;
                            bins[index].count += 1;
                        }
                    }
                    
                    // Build final output array for average
                    const result = bins.map((b, i) => {
                        const binStartMs = startMs + (i * binSizeMs);
                        return {
                            timestamp: new Date(binStartMs).toISOString(),
                            value: (b.count === 0) ? null : (b.sum / b.count)
                        };
                    });
                    
                    resolve(result);
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
                    
                    resolve(result);
                }
            });
        });
    }
    
    /**
     * Store a sensor reading
     * @param {string} deviceId - Device ID (e.g., 'sensor1', 'sensor_1')
     * @param {string} type - Reading type (e.g., 'temperature', 'humidity')
     * @param {number} value - Reading value
     * @returns {Promise<number>} - Resolves with the sequence ID
     */
    async storeSensorReading(deviceId, type, value) {
        try {
            const sequenceId = await this.getNextSequenceId();
            
            return new Promise((resolve, reject) => {
                this.dataDb.run(
                    `INSERT INTO sensor_readings 
                    (sequence_id, device_id, type, value, timestamp) 
                    VALUES (?, ?, ?, ?, datetime('now'))`,
                    [sequenceId, deviceId, type, value],
                    function(err) {
                        if (err) {
                            console.error('Error storing sensor reading:', err);
                            reject(err);
                            return;
                        }
                        
                        // Update server sync information
                        this.configDb.run(
                            `UPDATE server_sync 
                            SET last_sequence = ? 
                            WHERE server_id = ?`,
                            [sequenceId, 'server'],
                            (err) => {
                                if (err) {
                                    console.error('Error updating server sync record:', err);
                                    // Don't reject, the reading was stored successfully
                                }
                                
                                resolve(sequenceId);
                            }
                        );
                    }.bind(this)
                );
            });
        } catch (error) {
            console.error('Error in storeSensorReading:', error);
            throw error;
        }
    }
    
    /**
     * Update server sync record
     * @param {string} serverId - Server ID
     * @param {number} lastSequence - Last synced sequence ID
     * @param {number} sentCount - Number of records sent
     * @returns {Promise<void>} - Resolves when update is complete
     */
    async updateServerSync(serverId, lastSequence, sentCount) {
        return new Promise((resolve, reject) => {
            this.configDb.run(
                `INSERT OR REPLACE INTO server_sync 
                (server_id, last_sync_time, last_sequence, sent_count, last_seen)
                VALUES (?, datetime('now'), ?, ?, datetime('now'))`,
                [serverId, lastSequence, sentCount],
                (err) => {
                    if (err) {
                        console.error('Error updating server sync:', err);
                        reject(err);
                        return;
                    }
                    
                    resolve();
                }
            );
        });
    }
    
    /**
     * Get sensor stats summary
     * @returns {Promise<Object>} - Resolves with sensor stats
     */
    async getSensorStatsSummary() {
        try {
            // Get all sensors from config
            const sensors = await new Promise((resolve, reject) => {
                this.configDb.all('SELECT * FROM sensor_config', [], (err, rows) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(rows || []);
                });
            });
            
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
                    this.dataDb.get(
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
                    this.dataDb.get(
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
                
                // Get first timestamp
                const firstTimestamp = await new Promise((resolve, reject) => {
                    this.dataDb.get(
                        'SELECT MIN(timestamp) as timestamp FROM sensor_readings WHERE device_id = ?',
                        [deviceId],
                        (err, row) => {
                            if (err) reject(err);
                            else resolve(row && row.timestamp ? row.timestamp : null);
                        }
                    );
                });
                
                sensorStats.push({
                    id: sensor.id,
                    deviceId: deviceId,
                    name: sensor.name || `${sensor.type} ${sensor.address}`,
                    address: sensor.address,
                    type: sensor.type,
                    temperatureCount: tempCount,
                    humidityCount: humidityCount,
                    totalCount: sensorTotal,
                    firstTimestamp: firstTimestamp
                });
            }
            
            return {
                timestamp: new Date().toISOString(),
                sensors: sensorStats,
                totalRecordCount
            };
        } catch (error) {
            console.error('Error getting sensor stats summary:', error);
            throw error;
        }
    }
    
    /**
     * Get timezone setting
     * @returns {Promise<string>} - Resolves with timezone
     */
    async getTimezone() {
        return new Promise((resolve, reject) => {
            this.configDb.get('SELECT value FROM timezone WHERE key = ?', ['timezone'], (err, row) => {
                if (err) {
                    console.error('Error getting timezone:', err);
                    reject(err);
                    return;
                }
                
                resolve(row ? row.value : 'America/Los_Angeles');
            });
        });
    }
    
    /**
     * Set timezone
     * @param {string} timezone - Timezone to set
     * @returns {Promise<void>} - Resolves when timezone is set
     */
    async setTimezone(timezone) {
        return new Promise((resolve, reject) => {
            this.configDb.run('UPDATE timezone SET value = ? WHERE key = ?', [timezone, 'timezone'], (err) => {
                if (err) {
                    console.error('Error setting timezone:', err);
                    reject(err);
                    return;
                }
                
                resolve();
            });
        });
    }
    
    /**
     * Close database connections
     * @returns {Promise<void>} - Resolves when databases are closed
     */
    async close() {
        return new Promise((resolve, reject) => {
            if (this.configDb) {
                this.configDb.close((err) => {
                    if (err) {
                        console.error('Error closing config database:', err);
                        // Don't reject, try to close the other database
                    }
                    
                    if (this.dataDb) {
                        this.dataDb.close((err) => {
                            if (err) {
                                console.error('Error closing data database:', err);
                                reject(err);
                                return;
                            }
                            
                            this.configDb = null;
                            this.dataDb = null;
                            this.isInitialized = false;
                            resolve();
                        });
                    } else {
                        this.configDb = null;
                        this.isInitialized = false;
                        resolve();
                    }
                });
            } else if (this.dataDb) {
                this.dataDb.close((err) => {
                    if (err) {
                        console.error('Error closing data database:', err);
                        reject(err);
                        return;
                    }
                    
                    this.dataDb = null;
                    this.isInitialized = false;
                    resolve();
                });
            } else {
                // No databases to close
                this.isInitialized = false;
                resolve();
            }
        });
    }
}

module.exports = DatabaseController; 