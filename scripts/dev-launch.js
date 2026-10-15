// Starts the API from any working directory (used by editor/preview launchers):
// .env and ./uploads are resolved relative to the backend folder.
process.chdir(require('path').join(__dirname, '..'));
require('../src/server');
