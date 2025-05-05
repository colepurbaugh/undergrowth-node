// Configure pigpio to use the system daemon before loading the module
process.env.PIGPIO_ADDR = 'localhost';
process.env.PIGPIO_PORT = '8888';  // Default pigpio port
const Gpio = require('pigpio').Gpio;

// Pin to test
const PIN = 12;

console.log(`Starting PWM test on GPIO ${PIN}`);

try {
    // Initialize the pin
    console.log(`Initializing GPIO ${PIN}`);
    const led = new Gpio(parseInt(PIN), {mode: Gpio.OUTPUT});
    
    // Set PWM frequency
    console.log('Setting PWM frequency to 800Hz');
    led.pwmFrequency(800);
    
    // Test PWM at different values
    console.log('Setting PWM to 0');
    led.pwmWrite(0);
    
    setTimeout(() => {
        console.log('Setting PWM to 128');
        led.pwmWrite(128);
        
        setTimeout(() => {
            console.log('Setting PWM to 255');
            led.pwmWrite(255);
            
            setTimeout(() => {
                console.log('Setting PWM back to 0');
                led.pwmWrite(0);
                console.log('Test complete');
                process.exit(0);
            }, 2000);
        }, 2000);
    }, 2000);
} catch (error) {
    console.error('Error in PWM test:', error);
    process.exit(1);
} 