# Installation Instructions




## Pigpio Setup

- [Pigpio Download Page](https://abyz.me.uk/rpi/pigpio/download.html)
- [Pigpio C Library Repository](https://github.com/joan2937/pigpio)
- [Pigpio Node.js Package Repository](https://github.com/fivdi/pigpio)
- [Pigpio Node.js PWM Example](https://github.com/fivdi/pigpio?tab=readme-ov-file#pulse-an-led-with-pwm)
- [Pigpio Node.js Installation](https://github.com/fivdi/pigpio?tab=readme-ov-file#installation)
- [Pigpio NPM Package](https://www.npmjs.com/package/pigpio#pulse-an-led-with-pwm)

### 1. Install Pigpio C Library
```bash
# Download and extract source code
wget https://github.com/joan2937/pigpio/archive/master.zip
unzip master.zip
cd pigpio-master

# Compile and install
make
sudo make install
```

### 2. Install Node.js Package
```bash
npm install pigpio
```

### 3. Set Up Permissions
```bash
# Add user to necessary groups
sudo usermod -a -G gpio,i2c,spi,kmem $USER

# Reboot to apply group changes
sudo reboot
```

### 4. Run Server
```bash
# Run with sudo (required for port 80 and GPIO access)
sudo /home/willa/.nvm/versions/node/v22.14.0/bin/node server.js
```

Note: The server must be run with sudo to access GPIO pins and use port 80. The full path to node is required when using sudo with nvm-installed Node.js.
