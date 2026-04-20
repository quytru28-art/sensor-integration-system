# Camera Sensor Integration Guide

## Overview
This guide explains how to integrate a real camera sensor with your Sensor Integration System. We'll use a camera as the primary example, but these principles apply to any IoT sensor.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       Your Browser/Device                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Camera Hardware (Webcam/USB Camera/IP Camera)           │   │
│  │  ↓                                                         │   │
│  │  Capture Script (JavaScript/Node.js/Python)             │   │
│  │  ↓                                                         │   │
│  │  Convert to Base64/JPEG/Metadata                         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓ HTTP POST
┌─────────────────────────────────────────────────────────────────┐
│                      Express.js Server                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  POST /api/sensor-data/submit                            │   │
│  │  - Validate JWT token                                    │   │
│  │  - Verify device ownership                               │   │
│  │  - Process image data (compression, metadata)            │   │
│  │  - Store in database                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    SQLite Database                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  sensor_readings table                                   │   │
│  │  - device_id, timestamp, image_path, image_data_url     │   │
│  │  - metadata (resolution, brightness, motion_detected)   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                   React Frontend Dashboard                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Device Card Component                                   │   │
│  │  - Display live camera feed                              │   │
│  │  - Show image thumbnail grid                             │   │
│  │  - Display metadata (time, resolution, motion detection) │   │
│  │  - Historical playback controls                          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Three Implementation Strategies

### Strategy 1: Browser-Based Webcam (Simplest)
**Best for**: Testing, web-based dashboards, no hardware setup required
- Uses WebRTC API & getUserMedia()
- Runs entirely in browser
- Captures frames and uploads as JPEG/PNG
- No additional dependencies
- ✅ Works on Windows/Mac/Linux
- ❌ Can't run on mobile/headless devices
- ❌ Limited to browser security sandbox

### Strategy 2: Raspberry Pi / Device Capture (Most Common)
**Best for**: IoT deployments, 24/7 monitoring, unattended devices
- Uses OpenCV + Python or Node.js
- Runs as background service
- Captures and compresses frames
- Sends to server on schedule or on motion detection
- ✅ Works on any Linux device
- ✅ Real hardware integration
- ❌ Requires setup on device
- ❌ External dependencies

### Strategy 3: IP Camera Stream (Enterprise)
**Best for**: Existing CCTV infrastructure, remote cameras
- Reads MJPEG or RTSP stream from IP camera
- No setup on camera (uses network protocol)
- Server-side frame extraction
- ✅ No setup on camera
- ✅ Works with existing cameras
- ❌ Requires IP camera with network access
- ❌ Higher bandwidth usage

## Implementation Steps

### Step 1: Extend Database for Camera Data
Add new columns to store camera image data and metadata:
```sql
ALTER TABLE sensor_data ADD COLUMN image_data BLOB;
ALTER TABLE sensor_data ADD COLUMN image_url TEXT;
ALTER TABLE sensor_data ADD COLUMN metadata TEXT;  -- JSON with brightness, resolution, etc
```

### Step 2: Create Server Endpoint
Add new `/api/sensor-data/submit` endpoint that accepts:
- JWT token (authentication)
- device_id (which device)
- Image data (base64 encoded or raw binary)
- Metadata (timestamp, resolution, etc)

See: `server_sensor_endpoint.js` in this folder

### Step 3: Add Client Capture Script
Choose one of:
- **Browser**: `camera_browser_capture.js` (HTML page with video element)
- **Node.js/Raspberry Pi**: `camera_device_capture.py` (Python with OpenCV)
- **Generic HTTP**: Any device that can POST JPEG to endpoint

### Step 4: Update Frontend Dashboard
Add camera preview widget to device card:
- Display latest camera frame
- Show thumbnail grid of recent captures
- Add metadata display (capture time, image size, motion detection results)

See: Camera component example in this folder

### Step 5: Configure Data Storage
Decide on image storage strategy:
- **Option A**: Store as base64 in database (simple, slower)
- **Option B**: Save to disk, store path in database (faster, requires file management)
- **Option C**: Use cloud storage (S3, Cloudinary, etc)

## Data Flow Example

### Browser Webcam Flow
```
1. User opens dashboard
2. Click "Start Camera Feed" on device card
3. Browser requests camera permission
4. WebRTC captures frames (30fps)
5. Every 30 seconds, highest quality frame is selected
6. Frame encoded as JPEG (compression)
7. JPEG converted to base64
8. POST to /api/sensor-data/submit with image_data
9. Server validates JWT and device_id
10. Server compresses if needed, stores in DB
11. Frontend polls latest images and updates live preview
12. Motion detection metadata added
```

### Device Script Flow (Raspberry Pi)
```
1. Python script starts on boot (systemd service)
2. Script captures frame from USB camera every 10 seconds
3. Applies motion detection filter
4. Only one frame per minute is motion-detected
5. Frame compressed with OpenCV (reduce size 70%)
6. Convert to base64
7. POST with JWT token to server
8. Server deduplicates (skip if same as last frame)
9. Stores with metadata (motion_score, frame_size)
10. Server stores on disk under /uploads/device_1234/
11. Database stores path reference
12. Old frames auto-deleted after 30 days
```

## Next Steps

1. **Try Strategy 1 First** (Browser Webcam)
   - Easiest to test
   - No additional hardware needed
   - Good for understanding data flow

2. **Then move to Strategy 2** (if you have Raspberry Pi)
   - For continuous monitoring
   - More realistic sensor integration

3. **See implementation files:**
   - `server_sensor_endpoint.js` - Backend API
   - `camera_browser_capture.js` - Frontend capture
   - `camera_device_capture.py` - Raspberry Pi capture
   - `database_migrations.sql` - New DB columns

## Security Considerations

- All endpoints require JWT authentication
- Validate image size (max 2MB) to prevent abuse
- Rate limit uploads (max 1 per second per device)
- Sanitize metadata to prevent injection
- Consider image encryption if storing sensitive data
- Implement retention policy (auto-delete after 30 days)
- HTTPS only for image uploads

## Performance Tips

- Compress images (JPEG quality 70-80%)
- Use motion detection to skip duplicate frames
- Implement frame deduplication (skip if same as previous)
- Archive old images separately
- Use CDN for image serving if scaling
- Consider WebP format (30% smaller than JPEG)

## Troubleshooting

**Q: Camera permission denied in browser?**
A: HTTPS required for getUserMedia via WebRTC. Use localhost for testing, or enable unsafe origins.

**Q: Images not appearing on dashboard?**
A: Check browser console for errors. Verify JWT token not expired. Check image URL is valid.

**Q: Raspberry Pi connection fails?**
A: Verify network connectivity. Check server endpoint URL is correct. Validate device_id matches registered device.

**Q: High database size?**
A: Implement image compression. Add default retention policy. Archive old images to separate storage.
