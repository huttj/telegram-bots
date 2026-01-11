const fs = require('fs').promises;

class AuthManager {
  constructor(filePath) {
    this.filePath = filePath;
    this.authorizedUsers = new Set();
  }

  async initialize() {
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      this.authorizedUsers = new Set(JSON.parse(data));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Error loading authorized users:', error);
      }
    }
  }

  async saveAuthorizedUsers() {
    try {
      await fs.writeFile(this.filePath, JSON.stringify([...this.authorizedUsers]));
    } catch (error) {
      console.error('Error saving authorized users:', error);
    }
  }

  isAuthorized(chatId) {
    return this.authorizedUsers.has(chatId.toString());
  }

  addAuthorizedUser(chatId) {
    this.authorizedUsers.add(chatId.toString());
    this.saveAuthorizedUsers();
  }
}

const authManager = new AuthManager('authorized_users.json');

authManager.initialize();

module.exports = authManager;