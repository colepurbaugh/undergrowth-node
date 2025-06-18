# DietPi Configuration v1.0 (Stable) for Undergrowth Node

This directory contains the configuration files and automation scripts for setting up Raspberry Pi nodes running the undergrowth-node application using DietPi v1.0.

## Overview

DietPi v1.0 represents a stable configuration with proven reliability:
- Based on working backup configuration from successful deployments
- Automated willa user creation for secure rsync access
- Enhanced networking service hang detection and recovery
- Improved sensor initialization and error handling
- Better pigpio daemon management
- Streamlined installation process

## What You'll Need

- Raspberry Pi (tested on Pi 4, should work on Pi 3B+)
- MicroSD card (16GB or larger recommended)
- Computer with SD card reader
- WiFi network credentials
- AHT10/AHT20 temperature/humidity sensors (optional)

## Step 1: Download DietPi

1. Go to [DietPi.com](https://dietpi.com/)
2. Navigate to the Download section
3. Download the appropriate image for your Raspberry Pi model:
   - For Pi 4: `DietPi_RPi-ARMv8-Bookworm.img.xz`
   - For Pi 3B+: `DietPi_RPi-ARMv7-Bookworm.img.xz`

## Step 2: Flash the Image

1. Download and install [Balena Etcher](https://www.balena.io/etcher/)
2. Insert your microSD card into your computer
3. Open Etcher
4. Select the downloaded DietPi image file
5. Select your SD card as the target
6. Click "Flash" and wait for completion

## Step 3: Configure DietPi Files

After flashing, the SD card will have a boot partition accessible from your computer. Copy the configuration files from this directory:

1. Copy `dietpi.txt` to the root of the SD card (replace the existing file)
2. Copy `config.txt` to the root of the SD card (replace the existing file)
3. Copy `dietpi-wifi.txt` to the root of the SD card and edit WiFi credentials:
   - Replace `'your_ssid'` with your WiFi network name
   - Replace `'your_password'` with your WiFi password
4. Copy `Automation_Custom_Script.sh` to the root of the SD card

### Key Configuration Decisions

#### WiFi Setup
- **File**: `dietpi.txt`
- **Settings**: `AUTO_SETUP_NET_WIFI_ENABLED=1`, WiFi credentials
- **Why**: Enables headless WiFi connection without needing ethernet or monitor

#### SSH Access
- **File**: `dietpi.txt` 
- **Settings**: `AUTO_SETUP_SSH_SERVER_INDEX=-1` (Dropbear SSH)
- **Why**: Dropbear is lightweight and sufficient for our needs

#### Automatic Installation
- **File**: `dietpi.txt`
- **Settings**: `AUTO_SETUP_AUTOMATED=1`, `AUTO_SETUP_GLOBAL_PASSWORD=dietpi`
- **Why**: Enables fully automated installation without user interaction

#### Software Selection
- **File**: `dietpi.txt`
- **Settings**: No pre-installed software (handled by automation script)
- **Why**: Minimal installation with only required components

## Step 4: Installation Process

1. Insert the configured SD card into your Raspberry Pi
2. Power on the Pi (no monitor or keyboard needed)
3. Wait for the installation to complete (15-30 minutes)

### Known Issue: Networking Service Hang

**Important**: During installation, DietPi may appear to hang at:
```
Stopping networking.service - Raise network interfaces...
```

**This is a known DietPi bug and does NOT indicate a problem with WiFi connection.**

#### What's Actually Happening
- DietPi is transitioning from legacy networking to systemd-networkd
- The service stop command hangs due to a race condition
- WiFi connection is actually successful at this point
- The system is waiting for a service timeout

#### Recovery Steps
1. **Wait 2-3 minutes** to see if it resolves automatically
2. If still hung, perform a **hard reboot**:
   - Unplug power from the Pi
   - Wait 10 seconds
   - Plug power back in
3. The Pi will boot normally and complete installation
4. Check your router's admin panel to find the Pi's IP address

## Step 5: Verify Installation

After the Pi boots up:

1. SSH into the Pi: `ssh dietpi@<pi-ip-address>`
2. Check the undergrowth service: `sudo systemctl status ug-node`
3. Access the web interface: `http://<pi-ip-address>`
4. Verify sensors are working (if connected)

## Architecture and Security Decisions

### User Access Strategy

We implemented a dual-user approach for security:

#### Main Application User: `dietpi`
- Runs the undergrowth-node application
- Has full access to application files and databases
- Private credentials (not shared)
- Home directory: `/home/dietpi/git/undergrowth-node/`

#### Rsync Access User: `willa`
- **Username**: `willa`
- **Password**: `12grow34`
- **Purpose**: Provides read-only access to database files for server synchronization
- **Access Method**: Symbolic link to `/home/dietpi/git/undergrowth-node/database/`

### Why This Approach?

1. **Security Isolation**: Server can access database files without knowing dietpi credentials
2. **Principle of Least Privilege**: willa user only has access to database directory
3. **Standardization**: All nodes use the same willa credentials for consistency
4. **No Traversal Risk**: Symbolic linking prevents access to parent directories

### Database File Access

The server expects to find database files at:
```
willa@<node-ip>:~/git/undergrowth-node/database/node-<node-id>-data.db
```

This is achieved through:
1. Creating willa user with home directory `/home/willa`
2. Creating directory structure: `/home/willa/git/undergrowth-node/`
3. Symbolic linking: `/home/dietpi/git/undergrowth-node/database/` → `/home/willa/git/undergrowth-node/database/`
4. Setting read-only permissions for willa user

### Service Configuration

- **Service Name**: `ug-node`
- **User**: `root` (required for GPIO access)
- **Working Directory**: `/home/dietpi/git/undergrowth-node/`
- **Auto-start**: Enabled
- **Restart Policy**: Always restart on failure

## Troubleshooting

### Installation Hangs at Networking Service
- **Solution**: Wait 2-3 minutes, then hard reboot if necessary
- **Cause**: Known DietPi bug during service transition
- **Impact**: None - WiFi connection is successful

### Pigpio Daemon Issues
- **Symptoms**: GPIO operations fail, lock file errors
- **Solution**: Restart pigpio daemon: `sudo systemctl restart pigpiod`
- **Prevention**: Automation script includes pigpio restart

### Single Sensor Operation
- **Issue**: Code expects both sensors (0x38 and 0x39)
- **Current Behavior**: Errors when only one sensor connected
- **Future Fix**: Modify sensor initialization for OR logic instead of AND

### SSH Connection Refused
- **Check**: Ensure SSH is enabled in dietpi.txt
- **Verify**: Service status: `sudo systemctl status dropbear`
- **Alternative**: Use dietpi-config to enable SSH

### Web Interface Not Accessible
- **Check**: Service status: `sudo systemctl status ug-node`
- **Verify**: Port 80 is not blocked by firewall
- **Logs**: `sudo journalctl -u ug-node -f`

## File Structure

```
/home/dietpi/git/undergrowth-node/
├── ug-node.js              # Main application
├── package.json            # Node.js dependencies
├── database/               # SQLite databases
│   ├── ug-config.db       # Configuration data
│   └── <hostname>-data.db # Sensor readings
├── public/                 # Web interface files
└── node_modules/          # Installed dependencies

/home/willa/git/undergrowth-node/
└── database/              # Bind mount (read-only)
    └── <hostname>-data.db # Accessible via rsync
```

## Version History

- **v4**: Basic DietPi setup with manual configuration
- **v5**: Added willa user automation, networking hang fix, improved error handling

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review system logs: `sudo journalctl -u ug-node`
3. Verify network connectivity and SSH access
4. Check sensor connections if using I2C devices

## Security Notes

- Default dietpi password is set to `dietpi` for initial setup
- Change default passwords after installation for production use
- willa user has minimal privileges (read-only database access)
- SSH is enabled by default - consider key-based authentication for production

## Critical Configuration Notes

### I2C Configuration
The `config.txt` file includes a critical I2C configuration line:
```
dtparam=i2c=on
```
This line is essential for sensor operation and must not be removed.

### CPU Frequency Settings
The configuration uses conservative CPU settings for stability:
- `arm_freq=1000` (commented out - uses default)
- `core_freq=400` (commented out - uses default)

These settings have been tested for reliability across multiple deployments. 