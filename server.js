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

// Add new endpoint for binned data
app.get('/api/readings/binned', (req, res) => {
    const { startDate, hours, points, type } = req.query;
    
    if (!startDate || !hours || !points || !type) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    const endDate = new Date(new Date(startDate).getTime() + (parseInt(hours) * 3600 * 1000)).toISOString();
    
    db.all(`
        SELECT 
            strftime('%Y-%m-%d %H:%M:%S', timestamp) as timestamp,
            AVG(value) as value
        FROM sensor_readings
        WHERE timestamp BETWEEN ? AND ?
            AND type = ?
        GROUP BY strftime('%Y-%m-%d %H:%M:%S', timestamp)
        ORDER BY timestamp ASC
        LIMIT ?
    `, [startDate, endDate, type, parseInt(points)], (err, rows) => {
        if (err) {
            console.error('Error fetching binned data:', err);
            return res.status(500).json({ error: 'Failed to fetch data' });
        }
        res.json(rows);
    });
});

// Initialize Raspberry Pi and then start the application
raspi.init(() => {
    initPwmPins(); // Initialize PWM pins
    initAndRead();
    
    server.listen(80, () => {
        console.log('Server is running on port 80');
    });
}); 