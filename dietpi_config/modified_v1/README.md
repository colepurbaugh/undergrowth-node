# DietPi Configuration for Undergrowth Nodes

This repository contains configuration files for setting up DietPi with pigpio support for the Undergrowth Node project.

## Required Hardware
1. Raspberry pi 2 zero w
2. MicroSD card 8G+
3. Access to wifi
4. AHT10 temp/humidity sensor (i2c)
5. GPIO PWM outputs (GPIO12, GPIO13, GPIO18, GPIO19)

## Before Installation

Before flashing your SD card with DietPi, you must modify these files with your credentials:

1. In `dietpi.txt`:
   - Change `AUTO_SETUP_GLOBAL_PASSWORD=YOUR_PASSWORD` to your desired password

2. In `dietpi-wifi.txt`:
   - Change `aWIFI_SSID[0]='YOUR_SSID'` to your WiFi network name
   - Change `aWIFI_KEY[0]='YOUR_PASSWORD'` to your WiFi password

## Installation Process

1. Modify the credential files as mentioned above
2. Flash a microSD card with DietPi OS (DietPi_RPi234-ARMv8-Bookworm.img)
3. Copy these configuration files to the boot partition of the SD card
4. Insert the SD card into your Raspberry Pi and power it on
5. The system will automatically:
   - Configure the OS
   - Set up networking
   - Run the custom installation script
   - Install all required software
   - Configure the system for GPIO access

## Configuration Changes

The following modifications have been made to the default DietPi configuration:

### config.txt
- Enabled GPIO: `dtparam=gpio=on`
- Enabled I2C: `dtparam=i2c_arm=on`
- Enabled SPI: `dtparam=spi=on`

### Automation_Custom_Script.sh
A custom installation script that:
1. Enables necessary hardware interfaces (GPIO, I2C, SPI)
2. Installs Python dependencies
3. Installs and configures pigpio C library
4. Creates pigpio socket directory for improved reliability
5. Sets up pigpiod as a systemd service with proper configuration
6. Installs Node.js and required npm packages
7. Clones and configures the undergrowth-node repository
8. Sets up the undergrowth Node.js application as a service

## Testing pigpio

After installation, you can test if pigpio is working correctly with:

```bash
# Test GPIO reading
pigs r 0
# Set a pin to output mode
pigs m 12 1
# Set PWM frequency (800Hz)
pigs pfs 12 800
# Set PWM range (optional)
pigs prs 12 1000
# Generate PWM (50% duty cycle)
pigs p 12 500
```

## Troubleshooting

If you encounter issues with pigpio:

1. Check service status:
   ```
   systemctl status pigpiod
   ```

2. View installation logs:
   ```
   cat /var/tmp/dietpi/logs/dietpi-automation_custom_script.log
   ```

3. Restart the service:
   ```
   systemctl restart pigpiod
   ``` 