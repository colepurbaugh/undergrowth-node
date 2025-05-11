# DietPi Configuration for Undergrowth Nodes

This repository contains optimized configuration files for setting up DietPi with pigpio support for the Undergrowth Node project, with specific improvements for WiFi reliability and system stability.

## Required Hardware
1. Raspberry Pi Zero W (or compatible model)
2. MicroSD card 8GB+
3. Access to WiFi
4. AHT10 temperature/humidity sensor (I2C)
5. GPIO PWM outputs (GPIO12, GPIO13, GPIO18, GPIO19)
6. Stable 5V/2.5A power supply (important for WiFi stability)

## Before Installation

Before flashing your SD card with DietPi, you must modify these files with your credentials:

1. In `dietpi.txt`:
   - Change `AUTO_SETUP_GLOBAL_PASSWORD=undergrowth` to your desired password

2. In `dietpi-wifi.txt`:
   - Change `aWIFI_SSID[0]='SPUTNICK'` to your WiFi network name
   - Change `aWIFI_KEY[0]='goldfish123!'` to your WiFi password

## Installation Process

1. Modify the credential files as mentioned above
2. Flash a microSD card with DietPi OS (DietPi_RPi234-ARMv8-Bookworm.img)
3. Copy these configuration files to the boot partition of the SD card
4. Insert the SD card into your Raspberry Pi and power it on
5. The system will automatically:
   - Configure the OS with optimized settings
   - Set up networking with robust error recovery
   - Run the custom installation script
   - Install all required software
   - Configure the system for maximum reliability

## Power and Performance Optimizations

This version includes important optimizations to prevent WiFi and boot issues:

1. **Temporary Elevated Power Settings**:
   - Higher voltage (`over_voltage=4`) during installation
   - Lower CPU frequency (`arm_freq=900`) during installation for stability
   - Optimized core frequency (`core_freq=250`) for better WiFi reliability

2. **Post-Installation Balanced Settings**:
   - Reduced voltage (`over_voltage=2`) for daily operation
   - Increased CPU frequency (`arm_freq=1000`) for better performance
   - Disabled power management for WiFi connections

3. **Hardware Optimizations**:
   - Disabled Bluetooth to reduce resource usage
   - Disabled IPv6 to simplify network configuration
   - Balanced GPU memory settings to support both headless and display modes
   - Configured zram for swap to reduce SD card wear

## Display Support

The system supports both headless operation and connecting a display when needed:

- Can run completely headless with no display attached
- Automatically detects and activates HDMI when a display is connected
- Supports connecting a display during installation for monitoring
- Supports connecting a display after installation for troubleshooting

To view the installation progress directly, you can connect an HDMI display at any time.

## Robustness Improvements

The configuration includes multiple layers of protection against failures:

1. **Network Reliability**:
   - WiFi watchdog with automatic reconnection
   - Extended connection timeout settings
   - Disabled power saving mode for WiFi
   - Increased WiFi transmit power during setup

2. **System Protection**:
   - Hardware watchdog for automatic recovery if system freezes
   - Read-only boot partition after installation
   - Log2ram to reduce SD card wear
   - Disabled unnecessary services

3. **Comprehensive Logging**:
   - All installation logs saved to SD card boot partition
   - Automatic network diagnostics at boot and on connection issues
   - Detailed success/failure logs written to `/boot/verification_logs/`
   - Status indicator file at `/boot/INSTALL_STATUS.txt`

## Troubleshooting

The automatic verification system will create one of these files on the boot partition:

1. `/boot/INSTALL_STATUS.txt` - Contains either "INSTALLATION SUCCESSFUL!" or "INSTALLATION FAILED"

If installation fails, check:
- `/boot/verification_logs/INSTALLATION_FAILED.log` - Complete details about the failure
- `/boot/install_log.txt` - Full installation process log
- `/boot/logs/network-*.log` - Network diagnostic logs

Common issues:
1. Inadequate power supply (most WiFi issues are power-related)
2. Incorrect WiFi credentials
3. Interference or weak WiFi signal
4. Corrupted SD card or poor quality SD card

## Enhanced Service Configuration

The ug-node service is configured with:
- Network dependency to ensure it starts only after network is available
- 15-second delay before starting to ensure system stability
- Automatic restart on failure with appropriate delays
- Proper standardized logging to system journal
- Compatibility with hardware watchdog

## Testing the Installation

After installation, you can check service status:
```bash
# Check service status
systemctl status ug-node

# View service logs
journalctl -u ug-node -f

# Test pigpio
pigs r 0
``` 