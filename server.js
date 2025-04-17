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
        // Create sensor readings table if it doesn't exist
        db.run(`
            CREATE TABLE IF NOT EXISTS sensor_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                device_id TEXT NOT NULL,
                type TEXT NOT NULL,
                value REAL NOT NULL
            )
        `, (err) => {
            if (err) {
                console.error('Error creating table:', err);
            } else {
                console.log('Sensor readings table initialized');
            }
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

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected');

    // Handle PWM set requests
    socket.on('pwmSet', (data) => {
        const { pin, value } = data;
        if (pwmEnabled && pwmPins[pin]) {
            try {
                // Convert value from 0-1023 to 0-255 range
                const pwmValue = Math.floor((value / 1023) * 255);
                pwmPins[pin].pwmWrite(pwmValue);
                pwmPins[pin]._pwmValue = value; // Store original value
                socket.emit('pwmState', {
                    pin: pin,
                    value: value,
                    enabled: pwmValue > 0
                });
            } catch (error) {
                console.error(`Error setting PWM value for pin ${pin}:`, error);
                socket.emit('pwmError', { pin, message: 'Failed to set PWM value' });
            }
        } else {
            socket.emit('pwmError', { pin, message: 'PWM is not available' });
        }
    });

    // Handle PWM toggle requests
    socket.on('pwmToggle', (data) => {
        const { pin, enabled } = data;
        if (pwmEnabled && pwmPins[pin]) {
            try {
                if (enabled) {
                    const value = pwmPins[pin]._pwmValue || 0;
                    const pwmValue = Math.floor((value / 1023) * 255);
                    pwmPins[pin].pwmWrite(pwmValue);
                } else {
                    pwmPins[pin].pwmWrite(0);
                }
                socket.emit('pwmState', {
                    pin: pin,
                    value: pwmPins[pin]._pwmValue || 0,
                    enabled: enabled
                });
            } catch (error) {
                console.error(`Error toggling PWM for pin ${pin}:`, error);
                socket.emit('pwmError', { pin, message: 'Failed to toggle PWM' });
            }
        } else {
            socket.emit('pwmError', { pin, message: 'PWM is not available' });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

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

// Initialize Raspberry Pi and then start the application
raspi.init(() => {
    initPwmPins(); // Initialize PWM pins
    initAndRead();
    
    server.listen(80, () => {
        console.log('Server is running on port 80');
    });
}); 