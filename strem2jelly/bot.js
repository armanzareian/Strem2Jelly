const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const { promisify } = require('util');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input'); // npm i input
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram/tl');
const mongoose = require('mongoose');

const pipeline = promisify(stream.pipeline);
console.log(process.env)
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminUsers = process.env.ADMIN_USERS.split(',').map(id => parseInt(id.trim()));
const bot = new TelegramBot(token, {polling: true});

const mediaFolder = process.env.MEDIA_FOLDER_PATH;
const defaultFolder = path.join(mediaFolder, 'no_cat');
const SESSION_FILE_PATH = path.join(__dirname, 'session.json');
const PROGRESS_UPDATE_INTERVAL = 1000; // 5 seconds

// Jellyfin API configuration
const JELLYFIN_API_URL = process.env.JELLYFIN_API_URL || 'http://localhost:8096';
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;
const JELLYFIN_USER_ID = process.env.JELLYFIN_USER_ID;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

// Supported video file extensions
const supportedExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg'];

// User folder selection
const userFolders = {};
const pendingDownloads = {};
// Bot states
const states = {
  MAIN_MENU: 'MAIN_MENU',
  CREATING_FOLDER: 'CREATING_FOLDER',
  SELECTING_FOLDER: 'SELECTING_FOLDER',
  DOWNLOAD_CONFIRMATION: 'DOWNLOAD_CONFIRMATION'
};

// Current state for each user
const userStates = {};

// List of reserved names (commands, menu options, and keywords)
const reservedNames = ['create folder', 'select folder', 'cancel', 'back to main menu', 'no category', 'main menu'];

console.log(defaultFolder)
// Ensure default folder exists
if (!fs.existsSync(defaultFolder)) {
  fs.mkdirSync(defaultFolder, { recursive: true });
}

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

  const UserSchema = new mongoose.Schema({
    telegramId: { type: Number, unique: true },
    username: String,
    downloadedFiles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'File' }]
  });
  
  const FileSchema = new mongoose.Schema({
    fileName: String,
    filePath: String,
    downloadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    downloadedAt: { type: Date, default: Date.now }
  });
  
  const User = mongoose.model('User', UserSchema);
  const File = mongoose.model('File', FileSchema);
  
  // Function to get or create a user
  async function getOrCreateUser(telegramId, username) {
    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({ telegramId, username });
      await user.save();
    }
    return user;
  }
  
  // Function to add a downloaded file to the database
  async function addDownloadedFile(telegramId, username, fileName, filePath) {
    const user = await getOrCreateUser(telegramId, username);
    const file = new File({
      fileName,
      filePath,
      downloadedBy: user._id
    });
    await file.save();
    user.downloadedFiles.push(file._id);
    await user.save();
  }
async function initializeClient() {
  let sessionData = '';
  if (fs.existsSync(SESSION_FILE_PATH)) {
    sessionData = fs.readFileSync(SESSION_FILE_PATH, 'utf8');
    console.log('Loaded existing session');
  }

  const stringSession = new StringSession(sessionData);
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    if (!sessionData) {
      console.log('No saved session found. Please log in.');
      await client.start({
        phoneNumber: async () => PHONE_NUMBER,
        password: async () => await input.text('Please enter your password: '),
        phoneCode: async () => await input.text('Please enter the code you received: '),
        onError: (err) => console.log(err),
      });
      console.log('Login successful.');
      
      // Save the new session
      const sessionString = client.session.save();
      fs.writeFileSync(SESSION_FILE_PATH, sessionString);
      console.log('New session saved to', SESSION_FILE_PATH);
    } else {
      console.log('Connecting with existing session...');
      await client.connect();
      console.log('Connected successfully.');
    }

    // Test the connection by getting the current user
    const me = await client.getMe();
    console.log('Logged in as:', me.id);
    
    return client;
  } catch (error) {
    if (error.message.includes('AUTH_KEY_UNREGISTERED')) {
      console.log('Saved session is invalid. Initiating new login...');
      // Delete the invalid session file
      if (fs.existsSync(SESSION_FILE_PATH)) {
        fs.unlinkSync(SESSION_FILE_PATH);
      }
      // Recursive call to initializeClient to start a new login process
      return initializeClient();
    } else {
      console.error('Error during login:', error);
      throw error; // Re-throw the error if it's not the one we're handling
    }
  }
}

let client;
let my_id
(async () => {
  try {
    client = await initializeClient();
    my_id = parseInt((await client.getMe()).id)
    console.log('Telegram client initialized successfully.');
  } catch (error) {
    console.error('Failed to initialize Telegram client:', error);
    process.exit(1); // Exit the process if we can't initialize the client
  }
})();

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = states.MAIN_MENU;
  sendMainMenu(chatId);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  
  if (!adminUsers.includes(msg.from.id)) {
    bot.sendMessage(chatId, 'Sorry, you are not authorized to use this bot.');
    return;
  }

  const text = msg.text ? msg.text.toLowerCase() : '';

  // Always process menu commands
  if (text === 'create folder' || text === 'select folder' || text === 'cancel') {
    handleMainMenuInput(chatId, text);
    return;
  }

  if (msg.text && msg.text.startsWith('http')) {
    await handleDownloadRequest(msg);
  } else if (msg.video || msg.document) {
    await handleForwardedVideo(msg);
  } else {
    handleTextInput(msg);
  }
});

function handleTextInput(msg) {
  const chatId = msg.chat.id;
  const text = msg.text.toLowerCase();

  switch(userStates[chatId]) {
    case states.MAIN_MENU:
      handleMainMenuInput(chatId, text);
      break;
    case states.CREATING_FOLDER:
      handleCreateFolderInput(chatId, msg.text);
      break;
    case states.SELECTING_FOLDER:
      handleSelectFolderInput(chatId, msg.text);
      break;
    default:
      // If state is unknown, reset to main menu
      userStates[chatId] = states.MAIN_MENU;
      sendMainMenu(chatId);
  }
}

function handleMainMenuInput(chatId, text) {
  switch(text) {
    case 'create folder':
      userStates[chatId] = states.CREATING_FOLDER;
      sendCreateFolderMenu(chatId);
      break;
    case 'select folder':
      userStates[chatId] = states.SELECTING_FOLDER;
      const folders = getFolders(mediaFolder);
      sendFolderSelectionMenu(chatId, folders);
      break;
    case 'cancel':
      bot.sendMessage(chatId, 'Operation cancelled.');
      sendMainMenu(chatId);
      break;
    default:
      sendMainMenu(chatId);
  }
}

function handleCreateFolderInput(chatId, folderName) {
  if (reservedNames.includes(folderName.toLowerCase()) || folderName.toLowerCase().includes('menu')) {
    bot.sendMessage(chatId, 'This name is reserved or contains a reserved word. Please choose a different name for your folder.');
    return;
  }

  const folderPath = path.join(mediaFolder, folderName);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
    userFolders[chatId] = folderPath;
    bot.sendMessage(chatId, `Folder "${folderName}" created and selected.`);
  } else {
    bot.sendMessage(chatId, `Folder "${folderName}" already exists. It has been selected.`);
    userFolders[chatId] = folderPath;
  }
  
  userStates[chatId] = states.MAIN_MENU;
  return sendMainMenu(chatId);
}

function handleSelectFolderInput(chatId, folderName) {
  const folders = getFolders(mediaFolder);
  if (folders.includes(folderName) || folderName === 'No Category') {
    userFolders[chatId] = folderName === 'No Category' ? defaultFolder : path.join(mediaFolder, folderName);
    bot.sendMessage(chatId, `Folder "${folderName}" selected.`);
    
    // If there's a pending download, update its folder and ask for confirmation again
    if (pendingDownloads[chatId]) {
      const downloadInfo = pendingDownloads[chatId];
      downloadInfo.folderName = folderName;
      downloadInfo.filePath = path.join(userFolders[chatId], downloadInfo.fileName);
      
      const keyboard = {
        inline_keyboard: [
          [
            { text: 'Confirm', callback_data: 'confirm_forward_download' },
            { text: 'Change Folder', callback_data: 'change_folder_forward' },
            { text: 'Cancel', callback_data: 'cancel_forward_download' }
          ]
        ]
      };
      
      bot.sendMessage(
        chatId,
        `Do you want to download "${downloadInfo.fileName}" to the folder "${folderName}"?`,
        { reply_markup: keyboard }
      );
    } else {
      userStates[chatId] = states.MAIN_MENU;
      return sendMainMenu(chatId);
    }
  } else {
    bot.sendMessage(chatId, 'Invalid folder selection. Please try again.');
    sendFolderSelectionMenu(chatId, folders);
  }
}

async function handleDownloadRequest(msg) {
  const chatId = msg.chat.id;
  const downloadFolder = userFolders[chatId] || defaultFolder;
  const folderName = path.basename(downloadFolder) === 'no_cat' ? 'No Category' : path.basename(downloadFolder);

  userStates[chatId] = states.DOWNLOAD_CONFIRMATION;
  
  // Store the download URL and message_id
  pendingDownloads[chatId] = {
    url: msg.text,
    messageId: msg.message_id,
    msg: msg
  };

  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Confirm', callback_data: 'confirm_download' },
        { text: 'Change Folder', callback_data: 'change_folder' },
        { text: 'Cancel', callback_data: 'cancel_download' }
      ]
    ]
  };

  await bot.sendMessage(
    chatId,
    `You're about to download to the folder: ${folderName}\nDo you want to proceed, change the folder, or cancel?`,
    { reply_markup: keyboard }
  );
}
function convertToChannelId(id) {
  if (!id)
    return undefined
  if (typeof id === 'string') {
    id = parseInt(id);
  }
  // Remove the -100 prefix if present
  if (id < 0) {
    id = parseInt(id.toString().slice(4));
  }
  return BigInt(id);
}
async function findForwardedMessageId(chatId, originalmessage) {
  const messages = await client.getMessages(chatId, {
    limit: 100, // Adjust this number based on how far back you want to search
    reverse: true // Start from the most recent message
  });
  try {
    // Get the original message content
    
    if (!messages || messages.length === 0) {
      throw new Error("Couldn't retrieve original message information");
    }
    // console.log(JSON.stringify(messages))
    // console.log(originalmessage)
    for (const message of messages) {
      // console.log(message?.fwdFrom?.fromId)
      if ((message?.fwdFrom?.fromId?.channelId?.toString() && originalmessage?.forward_origin?.type === 'channel' && message?.fwdFrom?.fromId?.channelId?.toString() === convertToChannelId(originalmessage?.forward_origin?.chat?.id)?.toString()) || (message?.fwdFrom?.fromId?.userId?.toString() && message?.fwdFrom?.fromId?.userId?.toString() === originalmessage?.forward_origin?.sender_user?.id?.toString())) {
        // Check if the content matches
      //   console.log(message.fwdFrom.fromId.userId)
      // console.log(originalmessage.forward_origin)
        if (message.date === originalmessage.date) {
          return message;
        }
      }
    }

    throw new Error("Forwarded message not found");
  } catch (error) {
    console.error("Error finding forwarded message:", error);
    throw error;
  }
}
async function downloadForwardedFile(chatId, downloadInfo) {
  try {
    let progressMessage = await bot.sendMessage(chatId, 'Starting download...', { reply_to_message_id: downloadInfo.msg.message_id });
    const forward_message_from = await bot.forwardMessage(my_id, chatId, downloadInfo.msg.message_id);
    const forward_message_to = await findForwardedMessageId(parseInt(token.split(":")[0]), forward_message_from);

    // Create a write stream to save the file
    const writer = fs.createWriteStream(downloadInfo.filePath);
    let downloadedBytes = 0;
    let lastUpdateTime = 0;
    let lastPercentage = 0;

    let mediaToDownload;
    if (forward_message_to.document) {
      mediaToDownload = forward_message_to.document;
    } else if (forward_message_to.video) {
      mediaToDownload = forward_message_to.video;
    } else if (forward_message_to.audio) {
      mediaToDownload = forward_message_to.audio;
    } else if (forward_message_to.voice) {
      mediaToDownload = forward_message_to.voice;
    } else {
      throw new Error("No downloadable content found in the forwarded message");
    }

    let totalBytes = mediaToDownload.size;

    const updateProgress = async (force = false) => {
      const now = Date.now();
      const percentCompleted = Math.round((downloadedBytes * 100) / totalBytes);
      
      if (force || (now - lastUpdateTime > 2000 && percentCompleted !== lastPercentage)) {
        lastUpdateTime = now;
        lastPercentage = percentCompleted;
        const progressBar = createProgressBar(percentCompleted);
        const progressText = `Downloading to: ${downloadInfo.folderName}\nProgress: ${percentCompleted}%\n${progressBar}`;
        
        try {
          await bot.editMessageText(progressText, {
            chat_id: chatId,
            message_id: progressMessage.message_id
          });
        } catch (error) {
          console.error('Error updating progress message:', error.message);
        }
      }
    };

    // Use the Telegram client to download the file
    const result = await client.downloadMedia(mediaToDownload, {
      outputFile: {
        write: async (chunk) => {
          await writer.write(chunk);
          downloadedBytes += chunk.length;
          await updateProgress();
        },
        close: () => writer.close(),
      },
    });

    // Ensure the write stream is closed
    await new Promise((resolve) => writer.on('finish', resolve));

    // Ensure 100% progress is shown
    await updateProgress(true);

    // Refresh Jellyfin library
    const jellyfinStatus = await refreshJellyfinLibrary();

    // Add the downloaded file to the database
    const msg = await bot.getChat(chatId);
    await addDownloadedFile(msg.id, msg.username, downloadInfo.fileName, downloadInfo.filePath);

    // Append final messages to the progress message
    const finalMessage = `Download completed: ${downloadInfo.fileName}\n\n${jellyfinStatus}`;
    await bot.editMessageText(finalMessage, {
      chat_id: chatId,
      message_id: progressMessage.message_id
    });

    // Verify if the file was actually saved
    if (fs.existsSync(downloadInfo.filePath)) {
      console.log(`File successfully saved to: ${downloadInfo.filePath}`);
    } else {
      throw new Error("File was not saved successfully.");
    }
  } catch (error) {
    let errorMessage = `Error occurred while downloading: ${error.message}`;
    bot.sendMessage(chatId, errorMessage);
    console.error('Download error:', error);
  }

  resetToMainMenu(chatId);
}
async function handleForwardedVideo(msg) {
  const chatId = msg.chat.id;
  const downloadFolder = userFolders[chatId] || defaultFolder;
  const folderName = path.basename(downloadFolder) === 'no_cat' ? 'No Category' : path.basename(downloadFolder);

  let fileId, fileName, fileSize;
  if (msg.video) {
    fileId = msg.video.file_id;
    fileName = msg.video.file_name || `video_${Date.now()}.mp4`;
    fileSize = msg.video.file_size;
  } else if (msg.document) {
    fileId = msg.document.file_id;
    fileName = msg.document.file_name || `document_${Date.now()}`;
    fileSize = msg.document.file_size;
  } else {
    bot.sendMessage(chatId, "Sorry, I couldn't find a video or document in this message.");
    return;
  }

  const filePath = path.join(downloadFolder, fileName);

  // Check if file already exists
  if (fs.existsSync(filePath)) {
    bot.sendMessage(chatId, `File "${fileName}" already exists in folder "${folderName}". Skipping download.`);
    return;
  }

  // Store download info for confirmation
  pendingDownloads[chatId] = {
    messageId: msg.message_id,
    fileName: fileName,
    filePath: filePath,
    folderName: folderName,
    msg: msg
  };

  // Ask for confirmation
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Confirm', callback_data: 'confirm_forward_download' },
        { text: 'Change Folder', callback_data: 'change_folder_forward' },
        { text: 'Cancel', callback_data: 'cancel_forward_download' }
      ]
    ]
  };

  await bot.sendMessage(
    chatId,
    `Do you want to download "${fileName}" to the folder "${folderName}"?`,
    { reply_markup: keyboard }
  );
}
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  if (data === 'confirm_download') {
    await bot.deleteMessage(chatId, messageId);
    if (pendingDownloads[chatId]) {
      const downloadMsg = {
        chat: { id: chatId },
        text: pendingDownloads[chatId].url,
        message_id: pendingDownloads[chatId].messageId,
        msg:callbackQuery.message
      };
      await handleDownload(downloadMsg);
      delete pendingDownloads[chatId];
    } else {
      await bot.sendMessage(chatId, "Sorry, I couldn't find the download link. Please send it again.");
      await resetToMainMenu(chatId);
    }
  } else if (data === 'change_folder') {
    await bot.deleteMessage(chatId, messageId);
    userStates[chatId] = states.SELECTING_FOLDER;
    const folders = getFolders(mediaFolder);
    sendFolderSelectionMenu(chatId, folders);
  } else if (data === 'cancel_download') {
    await bot.deleteMessage(chatId, messageId);
    await bot.sendMessage(chatId, "Download cancelled.");
    delete pendingDownloads[chatId];
    await resetToMainMenu(chatId);
  } if (data === 'confirm_forward_download') {
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.deleteMessage(chatId, callbackQuery.message.message_id);
    
    if (pendingDownloads[chatId]) {
      await downloadForwardedFile(chatId, pendingDownloads[chatId]);
      delete pendingDownloads[chatId];
    } else {
      await bot.sendMessage(chatId, "Sorry, I couldn't find the download information. Please try again.");
    }
  } else if (data === 'change_folder_forward') {
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.deleteMessage(chatId, callbackQuery.message.message_id);
    userStates[chatId] = states.SELECTING_FOLDER;
    const folders = getFolders(mediaFolder);
    sendFolderSelectionMenu(chatId, folders, 'forward');
  } else if (data === 'cancel_forward_download') {
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.deleteMessage(chatId, callbackQuery.message.message_id);
    await bot.sendMessage(chatId, "Download cancelled.");
    delete pendingDownloads[chatId];
    resetToMainMenu(chatId);
  }

  await bot.answerCallbackQuery(callbackQuery.id);
});
function resetToMainMenu(chatId) {
  userStates[chatId] = states.MAIN_MENU;
  return sendMainMenu(chatId);
}
async function handleDownload(msg) {
  const chatId = msg.chat.id;
  const originalUrl = msg.text;
  let downloadUrl = originalUrl;

  // Check if the URL starts with '127.0.0.1:11471' and modify if necessary
  if (originalUrl.startsWith('http://127.0.0.1:11471')) {
    downloadUrl = originalUrl.replace('127.0.0.1:11471', '65.109.234.74:11470');
  }

  try {
    const headResponse = await axios.head(downloadUrl, { timeout: 10000 });
    const contentLength = parseInt(headResponse.headers['content-length'], 10);
    const contentDisposition = headResponse.headers['content-disposition'];
    let fileName = 'downloaded_file';
    if (contentDisposition) {
      const fileNameMatch = contentDisposition.match(/filename="?(.+?)"?(?:;|$)/i);
      if (fileNameMatch) {
        fileName = fileNameMatch[1].replace(/["']/g, ''); // Remove any remaining quotes
      }
    }
    const fileExtension = path.extname(fileName).toLowerCase();
    if (!fileExtension || !supportedExtensions.includes(fileExtension)) {
      throw new Error(`Unsupported file format: ${fileExtension || 'unknown'}`);
    }

    const downloadFolder = userFolders[chatId] || defaultFolder;
    const folderName = path.basename(downloadFolder) === 'no_cat' ? 'No Category' : path.basename(downloadFolder);
    const filePath = path.join(downloadFolder, fileName);

    // Check if file already exists
    if (fs.existsSync(filePath)) {
      bot.sendMessage(chatId, `File "${fileName}" already exists in folder "${folderName}". Skipping download.`, { reply_to_message_id: msg.message_id });
      return;
    }

    const writer = fs.createWriteStream(filePath);
    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      timeout: 30000 // 30 seconds timeout for the request
    });

    let downloadedBytes = 0;
    let progressMessage = null;

    response.data.on('data', (chunk) => {
      downloadedBytes += chunk.length;
    });

    // Set up an interval to update the progress
    const progressInterval = setInterval(async () => {
      const percentCompleted = Math.round((downloadedBytes * 100) / contentLength);
      const progressBar = createProgressBar(percentCompleted);
      const progressText = `Downloading to: ${folderName}\nProgress: ${percentCompleted}%\n${progressBar}`;
      
      try {
        if (progressMessage) {
          await bot.editMessageText(progressText, {
            chat_id: chatId,
            message_id: progressMessage.message_id
          });
        } else {
          progressMessage = await bot.sendMessage(chatId, progressText, { reply_to_message_id: msg.message_id });
        }
      } catch (error) {
        if (error.response && error.response.description !== 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message') {
          console.error('Error updating progress message:', error.message);
        }
      }
    }, PROGRESS_UPDATE_INTERVAL);

    await pipeline(response.data, writer);
    clearInterval(progressInterval);

    // Ensure 100% progress is shown
    const finalProgressText = `Downloading to: ${folderName}\nProgress: 100%\n${'█'.repeat(20)}`;
    await bot.editMessageText(finalProgressText, {
      chat_id: chatId,
      message_id: progressMessage.message_id
    });

    // Refresh Jellyfin library
    const jellyfinStatus = await refreshJellyfinLibrary();
    await addDownloadedFile(msg.msg.from.id, msg.msg.from.username, fileName, filePath);

    // Append final messages to the progress message
    const finalMessage = `${finalProgressText}\n\nFile downloaded successfully: ${fileName}\n\n${jellyfinStatus}`;
    await bot.editMessageText(finalMessage, {
      chat_id: chatId,
      message_id: progressMessage.message_id
    });
    resetToMainMenu(chatId);
  } catch (error) {
    let errorMessage = `Error occurred: ${error.message}`;
    if (error.response) {
      errorMessage += ` (Status: ${error.response.status})`;
    }
    bot.sendMessage(chatId, errorMessage, { reply_to_message_id: msg.message_id });
    console.error('Download error:', errorMessage);
    resetToMainMenu(chatId);
  }
}

function createProgressBar(percent) {
  const filledLength = Math.round(20 * percent / 100);
  const emptyLength = 20 - filledLength;
  return '█'.repeat(filledLength) + '░'.repeat(emptyLength);
}

async function refreshJellyfinLibrary() {
  try {
    const response = await axios.post(
      `${JELLYFIN_API_URL}/Library/Refresh`,
      {},
      {
        params: {
          api_key: JELLYFIN_API_KEY,
          userId: JELLYFIN_USER_ID
        }
      }
    );
    if (response.status === 204) {
      return 'Jellyfin library refresh initiated successfully.';
    } else {
      throw new Error(`Unexpected response status: ${response.status}`);
    }
  } catch (error) {
    console.error('Error refreshing Jellyfin library:', error.message);
    return 'Failed to refresh Jellyfin library. Please check server logs.';
  }
}

function sendMainMenu(chatId) {
  const keyboard = {
    keyboard: [
      [{ text: 'Create Folder' }, { text: 'Select Folder' }],
      [{ text: 'Cancel' }]
    ],
    resize_keyboard: true,
    persistent: true
  };
  return bot.sendMessage(chatId, 'Choose an option or send download link:', { reply_markup: keyboard });
}

function sendCreateFolderMenu(chatId) {
  const keyboard = {
    keyboard: [
      [{ text: 'Back to Main Menu' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
  bot.sendMessage(chatId, 'Enter a name for the new folder:', { reply_markup: keyboard });
}

function getFolders(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name === 'no_cat' ? 'No Category' : dirent.name);
}

function sendFolderSelectionMenu(chatId, folders, context = 'default') {
  const keyboard = folders.map(folder => ([{ text: folder }]));
  keyboard.push([{ text: 'Back to Main Menu' }]);
  
  let message = 'Select a folder:';
  if (context === 'forward') {
    message = 'Select a folder for the forwarded file:';
  }
  
  bot.sendMessage(chatId, message, { 
    reply_markup: { 
      keyboard: keyboard,
      resize_keyboard: true,
      one_time_keyboard: false
    } 
  });
}