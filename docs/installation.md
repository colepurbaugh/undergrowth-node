# Description
set up raspberry pis to act as nodes for greenhouse automation
web interface with:
- nodejs, nvm, npm, express, sqlite
GPIO manipulation with:
- pigpio on GPIO12, GPIO13, GPIO18, GPIO19
Github
- https://github.com/colepurbaugh/undergrowth-node

# Hardware
- UG-NODES -> Raspberry pi 2 zero w
-- AHT10, AHT20 temp/humidity
-- DS3231 RTC
-- VEML7700 light sensor
- UG-SERVERS -> Raspberry pi 4, Raspberry pi 5, PC

# Installation Instructions

https://dietpi.com/#download
https://dietpi.com/docs/install/

# Ssytem Package Installation
- git, build-essential, unzip, wget, i2c-tools, htop


'''
# 

## Auto Start with systemctl

### setup service

Create the systemd service file:
```bash
sudo nano /etc/systemd/system/ug-node.service
```

Add the following content:
```ini
[Unit]
Description=Undergrowth Node.js Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/willa/git/undergrowth-node
ExecStart=/home/willa/.nvm/versions/node/v22.14.0/bin/node ug-node.js
Environment=NODE_ENV=production
Environment=PATH=/home/willa/.nvm/versions/node/v22.14.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PIGPIO_ADDR=localhost
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=ug-node

[Install]
WantedBy=multi-user.target
```

Note: The service must run as root because the pigpio library requires root permissions to access `/dev/mem` for hardware PWM functionality. This is a limitation of the pigpio C library implementation. Currently the only way to use hardware PWM on the Raspberry Pi.

### setcap

Allow Node.js to bind to port 80:
```bash
sudo setcap 'cap_net_bind_service=+ep' /home/willa/.nvm/versions/node/v22.14.0/bin/node
```

### start, stop, status

Reload systemd and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable ug-node
sudo systemctl start ug-node
```

Check service status:
```bash
sudo systemctl status ug-node
```

Common service management commands:
- Start service: `sudo systemctl start ug-node`
- Stop service: `sudo systemctl stop ug-node`
- Restart service: `sudo systemctl restart ug-node`
- View logs: `sudo journalctl -u ug-node -f`

### changing node version

If you change Node.js versions using nvm:
1. Update the path in the service file
2. Run the setcap command on the new Node.js binary
3. Reload and restart the service

### changing directory and file name

The service name `ug-node` is used throughout the system. If you need to change it:
1. Update the service file name
2. Update all systemctl commands
3. Update the SyslogIdentifier in the service file

## Pigpio Setup
- [Raspberry Pi Hardware Page] (https://www.raspberrypi.com/documentation/computers/raspberry-pi.html)
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
sudo /home/willa/.nvm/versions/node/v22.14.0/bin/node ug-node.js
```

Note: The server must be run with sudo to access GPIO pins and use port 80. The full path to node is required when using sudo with nvm-installed Node.js.

## SQLite Command-Line Tools (Optional)

For troubleshooting and direct database manipulation, you can install the SQLite command-line tools:

```bash
# Install SQLite CLI on Debian/Ubuntu/Raspberry Pi OS
sudo apt-get update
sudo apt-get install sqlite3
```

### Basic Usage Examples

```bash
# Open a database file
sqlite3 ./database/ug-data.db

# Display tables in the database
.tables

# View database schema
.schema

# Run a query
SELECT * FROM sensor_readings LIMIT 10;

# Exit SQLite CLI
.exit
```

Note: These tools are not required for the Node.js application to function, as the sqlite3 npm package provides all necessary database functionality. The command-line tools are useful for manual inspection and troubleshooting only.
