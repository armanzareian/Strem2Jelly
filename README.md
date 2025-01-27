
# Media Management and Telegram Bot Project

This project combines three services (`Jellyfin`, `Stremio`, and `Telegram Bot`) into a single `docker-compose` setup for seamless media management, streaming, and interaction through Telegram.

---

## 📁 Project Structure

```
project-root/
├── docker-compose.yml   # Unified Docker Compose file for all services
├── .env                 # Environment variables for configuration
├── jellyfin/            # Jellyfin data folder
├── stremio/             # Stremio config folder
│   └── stremio-config/  # Configuration files for Stremio
└── strem2jelly/         # Telegram bot folder
    ├── Dockerfile       # Dockerfile for Telegram bot
    ├── bot.js           # Telegram bot source code
    ├── package.json     # Bot dependencies
    ├── package-lock.json# Dependency lock file
    └── other files...   # Additional files for bot
```

---

## 🛠️ Requirements

- Docker
- Docker Compose

---

## 📝 Setup Instructions

### 1. Clone the Repository
```bash
git clone <repository-url>
cd project-root
```

### 2. Configure Environment Variables
Create a `.env` file in the root directory and define the required variables:
```env
# Jellyfin paths
JELLYFIN_CONFIG_PATH=/mnt/HC_Volume_101347492/jellyfin/config
JELLYFIN_CACHE_PATH=/mnt/HC_Volume_101347492/jellyfin/cache
JELLYFIN_MEDIA_PATH=/mnt/HC_Volume_101347492/jellyfin/media

# Telegram bot variables
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
ADMIN_USERS=your-admin-users
JELLYFIN_API_URL=your-jellyfin-api-url
JELLYFIN_API_KEY=your-jellyfin-api-key
JELLYFIN_USER_ID=your-jellyfin-user-id
TELEGRAM_API_ID=your-telegram-api-id
TELEGRAM_API_HASH=your-telegram-api-hash
PHONE_NUMBER=your-phone-number
MONGODB_URI=your-mongodb-uri
MEDIA_FOLDER_PATH=${JELLYFIN_MEDIA_PATH}  # Reuse the Jellyfin media path
```

### 3. Build and Run the Services
Run the following command to build and start all services:
```bash
docker-compose up --build -d
```

### 4. Verify Services
Check that all containers are running:
```bash
docker ps
```

---

## 📦 Services

### 1. Jellyfin
Jellyfin is a media server for managing and streaming your media collection.
- **Access**: Runs in `host` network mode.
- **Volumes**:
  - Config: `${JELLYFIN_CONFIG_PATH}`
  - Cache: `${JELLYFIN_CACHE_PATH}`
  - Media: `${JELLYFIN_MEDIA_PATH}`

### 2. Stremio
Stremio is a streaming platform for movies, TV shows, and more.
- **Ports**:
  - `11470:11470`
  - `11471:11471`
- **Volumes**:
  - Config: `./stremio-config`

### 3. Telegram Bot (`strem2jelly`)
A custom bot for interacting with the Jellyfin server via Telegram.
- **Environment Variables**: Defined in the `.env` file.
- **Volumes**:
  - Media Path: `${MEDIA_FOLDER_PATH}`

---

## 🛠️ Useful Commands

### Stop All Services
```bash
docker-compose down
```

### View Logs
```bash
docker-compose logs -f
```

### Rebuild Services
```bash
docker-compose up --build -d
```

---

## 🧑‍💻 Development Notes

### Modifying the Telegram Bot
1. Navigate to the `strem2jelly` directory:
   ```bash
   cd strem2jelly
   ```
2. Make changes to the bot's code or dependencies.
3. Rebuild the bot service:
   ```bash
   docker-compose up --build -d telegram-bot
   ```

---

## 🌟 Contributing
Contributions are welcome! Please open a pull request or an issue for any enhancements or bug fixes.

---

## 📃 License
This project is licensed under the [MIT License](LICENSE).

---

## 💬 Contact
For any questions or support, feel free to reach out to the project maintainer.
