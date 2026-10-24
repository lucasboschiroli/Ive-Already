// Loads .env — from the project folder in dev, from the app's resources folder once installed.
const path = require('path');
const { app } = require('electron');
require('dotenv').config(app.isPackaged ? { path: path.join(process.resourcesPath, '.env') } : {});
