const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const raspi = require('raspi');
const { I2C } = require('raspi-i2c');
const AHT10 = require('./aht10');
const SystemInfo = require('./systemInfo');
const Gpio = require('pigpio').Gpio;
const path = require('path');

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

// Helper function to convert Celsius to Fahrenheit
function celsiusToFahrenheit(celsius) {
    return (celsius * 9/5) + 32;
}

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
                    // Convert temperatures to Fahrenheit
                    const temp1F = celsiusToFahrenheit(data1.temperature);
                    const temp2F = celsiusToFahrenheit(data2.temperature);

                    io.emit('sensorData', {
                        system: systemInfo.system,
                        sensor1: {
                            ...data1,
                            address: '0x38',
                            temperature: `${temp1F.toFixed(1)}°F (${data1.temperature.toFixed(1)}°C)`
                        },
                        sensor2: {
                            ...data2,
                            address: '0x39',
                            temperature: `${temp2F.toFixed(1)}°F (${data2.temperature.toFixed(1)}°C)`
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

// Initialize Raspberry Pi and then start the application
raspi.init(() => {
    initPwmPins(); // Initialize PWM pins
    initAndRead();
    
    server.listen(3000, () => {
        console.log('Undergrowth Node server running on port 3000');
    });
}); 