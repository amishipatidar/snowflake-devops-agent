---
name: incident-lockdown
description: Autonomously executes WAF configuration to block malicious traffic patterns and rate-limit endpoints during an active security incident (e.g., brute force attack).
---

# Incident Lockdown

This skill is executed by the Vigil reasoning engine when a security anomaly (like credential stuffing or a brute force attack) is detected with HIGH confidence.

## Usage

```bash
cortex -p "incident-lockdown <service-name> <severity> <ip-ranges> <target-endpoint>"
```

## Actions Performed
1. Updates WAF (Web Application Firewall) geo-blocking and IP blacklist rules.
2. Applies strict rate limits to the targeted endpoint (e.g., 10 req/min for `/api/auth/login`).
3. Enables CAPTCHA challenges for subsequent traffic from suspicious subnets.
4. Alerts the Security Operations Center (SOC).

## Output
Returns a JSON summary of the lockdown actions taken, including the number of IPs blocked and the new rate limits applied.
