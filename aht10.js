const { I2C } = require('raspi-i2c');

// Constants for AHT10
const AHT10_INIT_CMD = Buffer.from([0xE1, 0x08, 0x00]);
const AHT10_MEASURE_CMD = Buffer.from([0xAC, 0x33, 0x00]);
const AHT10_SOFT_RESET_CMD = Buffer.from([0xBA]);
const AHT10_CMD_DELAY = 100; // Increased from 20ms to 100ms
const AHT10_MEASUREMENT_DELAY = 100; // Increased from 80ms to 100ms

class AHT10 {
    constructor(i2c, address = 0x38) {
        this.i2c = i2c;
        this.address = address;
    }

    async initSensor() {
        try {
            // First perform a soft reset
            console.log(`Performing soft reset on sensor at 0x${this.address.toString(16)}...`);
            await this.softReset();
            await this._delay(200); // Wait longer after reset

            console.log(`Initializing sensor at 0x${this.address.toString(16)}...`);
            // Try to read status first
            try {
                const status = this.i2c.readSync(this.address, 1)[0];
                console.log(`Initial status byte for 0x${this.address.toString(16)}:`, status.toString(16));
                
                // If status bit 3 is already set, we don't need to initialize
                if ((status & 0x08) === 0x08) {
                    console.log(`Sensor at 0x${this.address.toString(16)} already calibrated`);
                    return true;
                }
            } catch (err) {
                console.log(`Could not read initial status for 0x${this.address.toString(16)}:`, err.message);
            }

            // Send initialization command in smaller chunks
            console.log(`Sending initialization command to 0x${this.address.toString(16)}...`);
            try {
                // Send first byte
                this.i2c.writeSync(this.address, Buffer.from([0xE1]));
                await this._delay(50);
                
                // Send second byte
                this.i2c.writeSync(this.address, Buffer.from([0x08]));
                await this._delay(50);
                
                // Send third byte
                this.i2c.writeSync(this.address, Buffer.from([0x00]));
                await this._delay(AHT10_CMD_DELAY);
                
                console.log(`Initialization command sent successfully to 0x${this.address.toString(16)}`);
            } catch (err) {
                console.error(`Failed to send initialization command to 0x${this.address.toString(16)}:`, err.message);
                throw err;
            }

            // Wait for calibration to complete
            let attempts = 0;
            let status = 0;
            while (attempts < 10) {
                try {
                    status = this.i2c.readSync(this.address, 1)[0];
                    console.log(`Status byte attempt ${attempts + 1} for 0x${this.address.toString(16)}:`, status.toString(16));
                    if ((status & 0x08) === 0x08) {
                        console.log(`AHT10 at 0x${this.address.toString(16)} initialized successfully.`);
                        return true;
                    }
                } catch (err) {
                    console.log(`Status read attempt ${attempts + 1} for 0x${this.address.toString(16)} failed:`, err.message);
                }
                await this._delay(100);
                attempts++;
            }

            throw new Error(`Sensor at 0x${this.address.toString(16)} not calibrated after multiple attempts`);
        } catch (err) {
            console.error(`Failed to initialize AHT10 at 0x${this.address.toString(16)}:`, err.message);
            return false;
        }
    }

    async softReset() {
        try {
            this.i2c.writeSync(this.address, AHT10_SOFT_RESET_CMD);
            await this._delay(AHT10_CMD_DELAY);
            console.log(`AHT10 at 0x${this.address.toString(16)} soft reset issued.`);
        } catch (err) {
            console.error(`Failed to perform soft reset on 0x${this.address.toString(16)}:`, err.message);
            throw err;
        }
    }

    async readTemperatureAndHumidity() {
        try {
            this.i2c.writeSync(this.address, AHT10_MEASURE_CMD);
            await this._delay(AHT10_MEASUREMENT_DELAY);

            const rawData = this.i2c.readSync(this.address, 6);
            if (rawData.length !== 6) throw new Error('Invalid data length');

            // Calculate humidity (fixed calculation)
            const humidityRaw = ((rawData[1] << 12) | (rawData[2] << 4) | (rawData[3] >> 4));
            const humidity = (humidityRaw * 100.0) / 0x100000;

            // Calculate temperature
            const temperatureRaw = ((rawData[3] & 0x0F) << 16) | (rawData[4] << 8) | rawData[5];
            const temperatureC = ((temperatureRaw * 200.0) / 0x100000) - 50;
            const temperatureF = (temperatureC * 9 / 5) + 32;

            // Apply calibration
            const temperatureOffset = -0.5;
            const humidityOffset = -2.0;
            const humidityScalingFactor = 0.85;

            const calibratedTemperature = temperatureF + temperatureOffset;
            let calibratedHumidity = (humidity * humidityScalingFactor) + humidityOffset;

            // Clamp humidity values
            if (calibratedHumidity > 100) calibratedHumidity = 100;
            if (calibratedHumidity < 0) calibratedHumidity = 0;

            // Validate temperature range
            if (calibratedTemperature < 32 || calibratedTemperature > 122) {
                throw new Error('Invalid calibrated temperature value');
            }

            return {
                temperature: parseFloat(calibratedTemperature.toFixed(2)),
                humidity: parseFloat(calibratedHumidity.toFixed(2)),
            };
        } catch (err) {
            console.error(`Failed to read AHT10 data from 0x${this.address.toString(16)}:`, err.message);
            await this.softReset(); // Attempt recovery
            return null;
        }
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = AHT10; 