#!/bin/bash
# Automation_Custom_PreScript.sh for undergrowth-node
# This script runs BEFORE DietPi's first boot setup and package installation
# Handles hostname setting based on MAC address

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
    
    # Update hostname in system files
    echo "$NEW_HOSTNAME" > /etc/hostname
    sed -i "s/127.0.1.1.*/127.0.1.1\t$NEW_HOSTNAME/" /etc/hosts
    hostname "$NEW_HOSTNAME"
    
    echo "Hostname set to $NEW_HOSTNAME"
else
    echo "Could not get MAC address. Hostname not changed."
fi

echo "Pre-installation setup completed!" 