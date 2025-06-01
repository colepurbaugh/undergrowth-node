#!/bin/bash
# Automation_Custom_PreScript.sh for undergrowth-node
# This script runs BEFORE DietPi's first boot setup and package installation
# Handles hardware configuration and system preparations

# Log to dietpi-automation_custom_prescript.log
exec &> >(tee -a /var/tmp/dietpi/logs/dietpi-automation_custom_prescript.log)

echo "Starting undergrowth-node pre-installation setup..."

# Get MAC address and set hostname
echo "Setting hostname based on MAC address..."
# Get MAC address of wireless adapter (wlan0)
MAC_ADDR=$(cat /sys/class/net/wlan0/address | tr -d ':' | tr '[a-z]' '[A-Z]')
if [ -n "$MAC_ADDR" ]; then
    # Extract the last 6 characters (3 bytes)
    LAST_SIX=${MAC_ADDR: -6}
    # Set the new hostname
    NEW_HOSTNAME="node-$LAST_SIX"
    echo "Setting hostname to $NEW_HOSTNAME based on MAC address $MAC_ADDR"
    
    # Update hostname in all required locations
    echo "$NEW_HOSTNAME" > /etc/hostname
    sed -i "s/127.0.1.1.*/127.0.1.1\t$NEW_HOSTNAME/" /etc/hosts
    hostname "$NEW_HOSTNAME"
    
    # If using DietPi, also update the DietPi config
    if [ -f "/boot/dietpi.txt" ]; then
        sed -i "s/^AUTO_SETUP_NET_HOSTNAME=.*/AUTO_SETUP_NET_HOSTNAME=$NEW_HOSTNAME/" /boot/dietpi.txt
    fi
else
    echo "Could not get MAC address. Hostname not changed."
fi

# Enable GPIO in config.txt if not already enabled
echo "Enabling GPIO in config.txt..."
if ! grep -q "^dtparam=gpio=on" /boot/config.txt; then
    echo "dtparam=gpio=on" >> /boot/config.txt
    echo "Added GPIO configuration to config.txt"
else
    echo "GPIO already enabled in config.txt"
fi

# Enable SPI in config.txt if not already enabled
echo "Enabling SPI in config.txt..."
if ! grep -q "^dtparam=spi=on" /boot/config.txt; then
    echo "dtparam=spi=on" >> /boot/config.txt
    echo "Added SPI configuration to config.txt"
else
    echo "SPI already enabled in config.txt"
fi

# Enable I2C in config.txt if not already enabled
echo "Enabling I2C in config.txt..."
if ! grep -q "^dtparam=i2c_arm=on" /boot/config.txt; then
    echo "dtparam=i2c_arm=on" >> /boot/config.txt
    echo "Added I2C configuration to config.txt"
else
    echo "I2C already enabled in config.txt"
fi

# Set I2C baudrate if not already set
if ! grep -q "^dtparam=i2c_arm_baudrate=" /boot/config.txt; then
    echo "dtparam=i2c_arm_baudrate=100000" >> /boot/config.txt
    echo "Added I2C baudrate configuration to config.txt"
else
    echo "I2C baudrate already configured in config.txt"
fi

echo "Pre-installation setup completed!"
echo "Hardware configurations will take effect after reboot." 