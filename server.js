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

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Create a single I2C instance
const i2c = new I2C();

// Create two sensor instances with different addresses, sharing the same I2C instance
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

// Load PWM states from database and initialize hardware
function loadPwmStates() {
    if (!pwmEnabled) return;

    db.all('SELECT pin, value, enabled FROM pwm_states', [], (err, rows) => {
        if (err) {
            console.error('Error loading PWM states:', err);
            return;
        }

        rows.forEach(row => {
            const pin = row.pin;
            const value = row.value;
            const enabled = row.enabled;

            if (pwmPins[pin]) {
                // Store the original value
                pwmPins[pin]._pwmValue = value;
                
                // Set the hardware state
                if (enabled) {
                    const pwmValue = Math.floor((value / 1023) * 255);
                    pwmPins[pin].pwmWrite(pwmValue);
                } else {
                    pwmPins[pin].pwmWrite(0);
                }
                
                console.log(`Loaded PWM state for pin ${pin}: value=${value}, enabled=${enabled}`);
            }
        });
    });
}

// Serve static files from public directory
app.use(express.static('public'));

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

// Initialize SQLite database
const db = new sqlite3.Database('./ug-node.db', (err) => {
    if (err) {
        console.error('Error connecting to SQLite:', err);
    } else {
        console.log('Connected to SQLite database');
        // Create tables
        db.serialize(() => {
            // Create safety_state table
            db.run(`CREATE TABLE IF NOT EXISTS safety_state (
                key TEXT PRIMARY KEY,
                value INTEGER,
                last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Create pwm_states table
            db.run(`CREATE TABLE IF NOT EXISTS pwm_states (
                pin INTEGER PRIMARY KEY,
                value INTEGER,
                enabled INTEGER,
                last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Create auto_pwm_states table
            db.run(`CREATE TABLE IF NOT EXISTS auto_pwm_states (
                pin INTEGER PRIMARY KEY,
                value INTEGER,
                enabled INTEGER,
                last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Create system_state table
            db.run(`CREATE TABLE IF NOT EXISTS system_state (
                key TEXT PRIMARY KEY,
                value INTEGER,
                last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Create events table
            db.run(`CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                gpio INTEGER,
                time TEXT,
                pwm_value INTEGER,
                enabled INTEGER DEFAULT 1
            )`);

            // Initialize states if not set
            db.get('SELECT value FROM system_state WHERE key = ?', ['automatic_mode'], (err, row) => {
                if (!err && !row) {
                    db.run('INSERT INTO system_state (key, value) VALUES (?, ?)', ['automatic_mode', 0]);
                }
            });

            // Initialize safety states
            db.get('SELECT value FROM safety_state WHERE key = ?', ['emergency_stop'], (err, row) => {
                if (!err && !row) {
                    db.run('INSERT INTO safety_state (key, value) VALUES (?, ?)', ['emergency_stop', 0]);
                }
            });
            db.get('SELECT value FROM safety_state WHERE key = ?', ['normal_enable'], (err, row) => {
                if (!err && !row) {
                    db.run('INSERT INTO safety_state (key, value) VALUES (?, ?)', ['normal_enable', 1]);
                }
            });

            // Initialize state_changes
            db.run('INSERT OR IGNORE INTO state_changes (key, value) VALUES (?, ?)', ['isChanged', 0]);

            // Initialize safety states if they don't exist
            db.run(`
                INSERT OR IGNORE INTO safety_state (key, value)
                VALUES ('emergency_stop', 0), ('normal_enable', 0)
            `);

            // Initialize PWM states if they don't exist
            db.run(`
                INSERT OR IGNORE INTO pwm_states (pin, value, enabled, last_modified)
                VALUES (12, 0, 0, CURRENT_TIMESTAMP), 
                       (13, 0, 0, CURRENT_TIMESTAMP), 
                       (18, 0, 0, CURRENT_TIMESTAMP), 
                       (19, 0, 0, CURRENT_TIMESTAMP)
            `);

            // Initialize system state if it doesn't exist
            db.run(`
                INSERT OR IGNORE INTO system_state (key, value)
                VALUES ('pwm_enabled', 0)
            `);

            // Initialize system state
            db.run(`INSERT OR IGNORE INTO system_state (key, value) VALUES ('mode', 1)`); // Default to manual mode

            // Initialize auto_pwm_states
            db.run(`INSERT OR IGNORE INTO auto_pwm_states (pin, value, enabled) VALUES (12, 0, 0)`);
            db.run(`INSERT OR IGNORE INTO auto_pwm_states (pin, value, enabled) VALUES (13, 0, 0)`);
            db.run(`INSERT OR IGNORE INTO auto_pwm_states (pin, value, enabled) VALUES (18, 0, 0)`);
            db.run(`INSERT OR IGNORE INTO auto_pwm_states (pin, value, enabled) VALUES (19, 0, 0)`);
        });
    }
});

// Initialize sensors and start reading
async function initAndRead() {
    try {
        // Initialize both sensors
        const [init1, init2] = await Promise.all([
            sensor1.initSensor(),
            sensor2.initSensor()
        ]);

        if (!init1 || !init2) {
            console.error('Failed to initialize one or both sensors');
            return;
        }
        
        // Read sensors every second
        setInterval(async () => {
            try {
                const [data1, data2, systemInfo] = await Promise.all([
                    sensor1.readTemperatureAndHumidity(),
                    sensor2.readTemperatureAndHumidity(),
                    SystemInfo.getSystemInfo()
                ]);

                if (data1 && data2) {
                    // Store readings in database
                    const timestamp = new Date().toISOString();
                    
                    // Store temperature readings
                    db.run(
                        'INSERT INTO sensor_readings (timestamp, device_id, type, value) VALUES (?, ?, ?, ?)',
                        [timestamp, 'sensor1', 'temperature', data1.temperature]
                    );
                    db.run(
                        'INSERT INTO sensor_readings (timestamp, device_id, type, value) VALUES (?, ?, ?, ?)',
                        [timestamp, 'sensor2', 'temperature', data2.temperature]
                    );
                    
                    // Store humidity readings
                    db.run(
                        'INSERT INTO sensor_readings (timestamp, device_id, type, value) VALUES (?, ?, ?, ?)',
                        [timestamp, 'sensor1', 'humidity', data1.humidity]
                    );
                    db.run(
                        'INSERT INTO sensor_readings (timestamp, device_id, type, value) VALUES (?, ?, ?, ?)',
                        [timestamp, 'sensor2', 'humidity', data2.humidity]
                    );

                    io.emit('sensorData', {
                        system: systemInfo.system,
                        sensor1: {
                            ...data1,
                            address: '0x38',
                            temperature: `${data1.temperature.toFixed(1)}°F (${((data1.temperature - 32) * 5/9).toFixed(1)}°C)`
                        },
                        sensor2: {
                            ...data2,
                            address: '0x39',
                            temperature: `${data2.temperature.toFixed(1)}°F (${((data2.temperature - 32) * 5/9).toFixed(1)}°C)`
                        }
                    });
                }
            } catch (error) {
                console.error('Error reading sensors:', error);
            }
        }, 1000);
    } catch (error) {
        console.error('Error initializing sensors:', error);
    }
}

// Function to broadcast safety state to all clients
function broadcastSafetyState() {
    db.all('SELECT key, value FROM safety_state', [], (err, rows) => {
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
    db.all('SELECT pin, value, enabled FROM pwm_states', [], (err, rows) => {
        if (err) {
            console.error('Server: Error fetching PWM states for broadcast:', err);
            return;
        }
        
        const pwmStates = {};
        rows.forEach(row => {
            pwmStates[row.pin] = {
                value: row.value,
                enabled: row.enabled === 1
            };
        });
        
        console.log('Server: Broadcasting PWM states:', pwmStates);
        io.emit('pwmStateUpdate', pwmStates);
    });
}

// Update emergency stop function
async function emergencyStop() {
    return new Promise((resolve) => {
        db.run('UPDATE safety_state SET value = 1 WHERE key = ?', ['emergency_stop'], resolve);
    });
}

// Update clear emergency stop function
async function clearEmergencyStop() {
    return new Promise((resolve) => {
        db.run('UPDATE safety_state SET value = 0 WHERE key = ?', ['emergency_stop'], resolve);
    });
}

// Update togglePWM function
async function togglePWM(pin, enabled) {
    return new Promise((resolve) => {
        // Get current value
        db.get('SELECT value FROM pwm_states WHERE pin = ?', [pin], (err, row) => {
            if (err) {
                console.error('Error getting PWM value:', err);
                resolve();
                return;
            }
            
            const value = row ? row.value : 0;
            
            // Update database
            db.run('UPDATE pwm_states SET enabled = ? WHERE pin = ?', [enabled ? 1 : 0, pin], (err) => {
                if (err) {
                    console.error('Error updating PWM state:', err);
                }
                
                // Update hardware
                if (pwmEnabled && pwmPins[pin]) {
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
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected');

    // Handle initial state request
    socket.on('getInitialState', async () => {
        try {
            const mode = await new Promise((resolve, reject) => {
                db.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.value : 1);
                });
            });

            const events = await new Promise((resolve, reject) => {
                db.all('SELECT * FROM events ORDER BY time', [], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });

            const safetyStates = await new Promise((resolve, reject) => {
                db.all('SELECT key, value FROM safety_state', [], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows.reduce((acc, row) => {
                        acc[row.key] = row.value;
                        return acc;
                    }, {}));
                });
            });

            // Update auto_pwm_states based on current active events
            const now = new Date();
            const currentTime = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

            // Find active events for each GPIO
            const activeEvents = {};
            events.forEach(event => {
                if (!event.enabled) return;

                const [hours, minutes, seconds] = event.time.split(':').map(Number);
                const eventTime = hours * 3600 + minutes * 60 + seconds;

                if (!activeEvents[event.gpio] || 
                    (eventTime <= currentTime && eventTime > (activeEvents[event.gpio].time || -1)) ||
                    (eventTime > currentTime && eventTime < (activeEvents[event.gpio].time || Infinity))) {
                    activeEvents[event.gpio] = {
                        time: eventTime,
                        event: event
                    };
                }
            });

            // Update auto_pwm_states
            for (const [gpio, activeEvent] of Object.entries(activeEvents)) {
                await new Promise((resolve, reject) => {
                    db.run('UPDATE auto_pwm_states SET value = ?, enabled = 1 WHERE pin = ?',
                        [activeEvent.event.pwm_value, gpio], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                });
            }

            socket.emit('initialState', {
                mode,
                events,
                safetyStates
            });
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
        console.log('Server: Received mode toggle:', data);
        const { automatic } = data;
        const mode = automatic ? 0 : 1; // 0 is automatic, 1 is manual
        try {
            db.run('UPDATE system_state SET value = ? WHERE key = ?',
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
        if (pwmEnabled && pwmPins[pin]) {
            try {
                // Store the original value
                pwmPins[pin]._pwmValue = value;
                
                // Update database
                console.log('Server: Updating database with value:', { pin, value });
                db.run('UPDATE pwm_states SET value = ?, last_modified = CURRENT_TIMESTAMP WHERE pin = ?',
                    [value, pin], (err) => {
                        if (err) {
                            console.error('Server: Error saving PWM state:', err);
                        } else {
                            console.log('Server: Database update successful, broadcasting state');
                            // Broadcast the new state to all clients
                            broadcastPWMState();
                        }
                    });
            } catch (error) {
                console.error(`Server: Error setting PWM value for pin ${pin}:`, error);
                socket.emit('pwmError', { pin, message: 'Failed to set PWM value' });
            }
        } else {
            console.log('Server: PWM not available for pin:', pin);
            socket.emit('pwmError', { pin, message: 'PWM is not available' });
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
            await new Promise((resolve, reject) => {
                db.run('INSERT INTO events (gpio, time, pwm_value, enabled) VALUES (?, ?, ?, ?)',
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
        db.all('SELECT * FROM events ORDER BY time', [], (err, rows) => {
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
                db.run('DELETE FROM events WHERE id = ?', [data.id], (err) => {
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
        
        db.run('UPDATE events SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id], (err) => {
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
                db.run('UPDATE system_state SET value = ? WHERE key = ?', 
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
});

// Function to broadcast events to all connected clients
function broadcastEvents() {
    db.all('SELECT * FROM events ORDER BY time', [], (err, rows) => {
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

    // 1) Fetch raw rows from DB
    const rawRows = await new Promise((resolve, reject) => {
      const sql = `
        SELECT timestamp, value
        FROM sensor_readings
        WHERE type = ?
          AND timestamp >= ?
          AND timestamp < ?
        ORDER BY timestamp ASC
      `;
      db.all(sql, [type, startIso, endIso], (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });

    if (!rawRows || rawRows.length === 0) {
      return res.json([]); // no data in that range => return empty
    }

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

    // 4) Build final output array
    const result = bins.map((b, i) => {
      const binStartMs = startMs + (i * binSizeMs);
      return {
        timestamp: new Date(binStartMs).toISOString(),
        value: (b.count === 0) ? null : (b.sum / b.count)
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Error in binned readings:', error);
    res.status(500).json({ error: 'Failed to fetch binned readings' });
  }
});

// Safety state management
function isSystemSafe() {
    return new Promise((resolve) => {
        db.get('SELECT value FROM safety_state WHERE key = ?', ['emergency_stop'], (err, row) => {
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
            db.get('SELECT value FROM safety_state WHERE key = ?', ['normal_enable'], (err, row) => {
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

    db.run('UPDATE safety_state SET value = ? WHERE key = ?', [enabled ? 1 : 0, 'normal_enable']);
    io.emit('safetyStateChanged', { normalEnable: enabled });
}

// Control loop for hardware updates
async function controlLoop() {
    try {
        // Get current safety states
        const safetyStates = await new Promise((resolve, reject) => {
            db.all('SELECT key, value FROM safety_state', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.reduce((acc, row) => {
                    acc[row.key] = row.value;
                    return acc;
                }, {}));
            });
        });

        // Get current mode
        const mode = await new Promise((resolve, reject) => {
            db.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.value : 1); // Default to manual mode
            });
        });

        // Get current PWM states based on mode
        const pwmStates = await new Promise((resolve, reject) => {
            const table = mode === 0 ? 'auto_pwm_states' : 'pwm_states';
            db.all(`SELECT pin, value, enabled FROM ${table}`, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.reduce((acc, row) => {
                    acc[row.pin] = { value: row.value, enabled: row.enabled };
                    return acc;
                }, {}));
            });
        });

        // Update hardware first (safety critical)
        if (pwmEnabled) {
            const isEmergencyStop = safetyStates.emergency_stop;
            const isNormalEnable = safetyStates.normal_enable;
            let stateChanged = false;

            Object.keys(pwmPins).forEach(pin => {
                if (pwmPins[pin]) {
                    const state = pwmStates[pin];
                    const currentValue = pwmPins[pin]._pwmValue || 0;
                    const currentEnabled = pwmPins[pin]._pwmEnabled || false;
                    
                    if (isEmergencyStop) {
                        // Emergency stop override - disable PWM regardless of mode
                        if (currentValue !== 0 || currentEnabled) {
                            pwmPins[pin].pwmWrite(0);
                            pwmPins[pin]._pwmValue = 0;
                            pwmPins[pin]._pwmEnabled = false;
                            stateChanged = true;
                        }
                    } else if (mode === 0 && !isNormalEnable) {
                        // Automatic mode requires normal enable
                        if (currentValue !== 0 || currentEnabled) {
                            pwmPins[pin].pwmWrite(0);
                            pwmPins[pin]._pwmValue = 0;
                            pwmPins[pin]._pwmEnabled = false;
                            stateChanged = true;
                        }
                    } else {
                        // Manual mode or automatic mode with normal enable
                        if (state && state.enabled) {
                            const pwmValue = Math.floor((state.value / 1023) * 255);
                            if (currentValue !== state.value || currentEnabled !== state.enabled) {
                                pwmPins[pin].pwmWrite(pwmValue);
                                pwmPins[pin]._pwmValue = state.value;
                                pwmPins[pin]._pwmEnabled = state.enabled;
                                stateChanged = true;
                            }
                        } else if (currentValue !== 0 || currentEnabled) {
                            pwmPins[pin].pwmWrite(0);
                            pwmPins[pin]._pwmValue = 0;
                            pwmPins[pin]._pwmEnabled = false;
                            stateChanged = true;
                        }
                    }
                }
            });

            // Only broadcast if state changed
            if (stateChanged) {
                broadcastPWMState();
            }
        }

    } catch (error) {
        console.error('Error in control loop:', error);
    }
}

// Start control loop
setInterval(controlLoop, 1000);

// Initialize Raspberry Pi and then start the application
raspi.init(() => {
    initPwmPins(); // Initialize PWM pins
    loadPwmStates(); // Load PWM states from database
    initAndRead();
    
    server.listen(80, () => {
        console.log('Server is running on port 80');
    });
}); 