# Undergrowth Node Troubleshooting Commands



```bash
# socket statistics
ss -tuln
```

## System Services (systemctl)

```bash
# Check status of a service
systemctl status pigpiod
systemctl status ug-node

# Start/stop/restart a service
systemctl start pigpiod
systemctl stop pigpiod
systemctl restart pigpiod

# Enable/disable service at boot
systemctl enable pigpiod
systemctl disable pigpiod

# Reload systemd after editing service files
systemctl daemon-reload

# View service logs (last 50 lines)
journalctl -u pigpiod -n 50
journalctl -u ug-node -n 50

# Follow logs in real-time
journalctl -u ug-node -f
```

## Database "ug-data.db"  (SQLite3)
```bash
# *********************************** sensor values ***********************************
# see first fiew rows
sqlite3 database/ug-data.db "SELECT * FROM sensor_readings LIMIT 5;"
# see record count
sqlite3 database/ug-data.db "SELECT COUNT(*) FROM sensor_readings;"
# see range of data
sqlite3 database/ug-data.db "SELECT MIN(timestamp), MAX(timestamp) FROM sensor_readings;"
```

## Database "ug-config.db"  (SQLite3)
```bash
sqlite3 ./database/ug-config.db .tables
#auto_pwm_states, safety_state, server_sync, events, sensor_config, system_state, pwm_states, sequence_tracker, timezone


# *********************************** modes ***********************************
# Check system mode (0=automatic, 1=manual)
sqlite3 ./database/ug-config.db "SELECT key, value FROM system_state WHERE key='mode'"
# Set system mode (0=automatic, 1=manual)
sqlite3 ./database/ug-config.db "UPDATE system_state SET value = 1 WHERE key = 'mode'"
# Check safety states
sqlite3 ./database/ug-config.db "SELECT key, value FROM safety_state"
#*********************************** manual ***********************************
# Check PWM values in database
sqlite3 ./database/ug-config.db "SELECT pin, value, enabled FROM pwm_states"
# Set manual PWM values for testing
sqlite3 ./database/ug-config.db "UPDATE pwm_states SET value = 500, enabled = 1 WHERE pin = 12"

#********************************** automatic **********************************
# Check scheduled events
sqlite3 ./database/ug-config.db "SELECT id, gpio, time, pwm_value, enabled FROM events ORDER BY time"
# Check automatic PWM values
sqlite3 ./database/ug-config.db "SELECT pin, value, enabled FROM auto_pwm_states"

# Add a test event (format: gpio, time in HH:MM:SS, pwm_value, enabled)
sqlite3 ./database/ug-config.db "INSERT INTO events (gpio, time, pwm_value, enabled) VALUES (12, '12:00:00', 500, 1)"
# Delete all events (be careful!)
sqlite3 ./database/ug-config.db "DELETE FROM events"
```

## Pigpio Commands

```bash
# Test reading GPIO pin state
pigs r 12

# Set GPIO pin high/low
pigs w 12 1
pigs w 12 0

# Set PWM duty cycle (0-255)
pigs p 12 128  # 50% duty cycle
pigs p 12 0    # off

# Test PWM frequency
pigs pfs 12 800  # Set PWM frequency to 800Hz

# Monitor GPIO pin changes
pigs no 12  # Notify open on GPIO 12
pigs nc     # Get notification handle's changes
pigs np     # Pause notifications
pigs nr     # Resume notifications

# Check pigpio version
pigpiod -v

# Start pigpio daemon manually with options
pigpiod -s 10  # Sample rate of 10μs (faster)
```

## Process Management

```bash
# Check running Node.js instances
ps aux | grep node

# Check memory usage
free -h

# Check disk space
df -h

# List system uptime and load
uptime

# Interactive process viewer
htop

# Find process using port 80
lsof -i :80
```

## Network Diagnostics

```bash
# Check network interfaces
ip addr

# Test connectivity
ping -c 4 8.8.8.8

# Check DNS resolution
nslookup google.com

# Check open ports
netstat -tuln
```

## Hardware Configuration

```bash
# Check if GPIO is enabled in config.txt
grep "dtparam=gpio" /boot/config.txt

# Check if I2C is enabled in config.txt
grep "dtparam=i2c" /boot/config.txt 

# Enable I2C interface
sudo /boot/dietpi/func/dietpi-set_hardware i2c enable

# Check loaded kernel modules
lsmod | grep -E 'i2c|gpio'

# Check I2C devices
i2cdetect -y 1

# Check hardware information
cat /proc/device-tree/model
vcgencmd measure_temp  # Raspberry Pi CPU temperature
```

## File System Operations

```bash
# Find files modified in the last 24 hours
find /root/git/undergrowth-node -type f -mtime -1

# Create a backup of configuration
cp -r /root/git/undergrowth-node/database /root/database_backup_$(date +%Y%m%d)

# Check file permissions
ls -la /dev/gpiomem
ls -la /dev/i2c*
```

## Git Operations

```bash
# Update code from GitHub
cd /root/git/undergrowth-node
git pull

# Check current git status
git status

# View commit history
git log --oneline -n 10
```

## Application Testing

```bash
# Run Node.js application manually
cd /root/git/undergrowth-node
node ug-node.js

# Check Node.js version
node -v

# Check NVM installed versions
nvm ls
```

## Common Issues and Fixes

```bash
# Fix pigpiod service not staying running
sudo nano /etc/systemd/system/pigpiod.service
# Change Type=simple to Type=forking

# Reboot the system (use with caution)
sudo reboot

# Manually control I2C and GPIO:
# 1. Add these lines to /boot/config.txt:
dtparam=i2c_arm=on
dtparam=gpio=on

# 2. Check for hardware changes after reboot:
ls /dev/i2c*
ls /dev/gpio*
```
