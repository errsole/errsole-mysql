const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const { EventEmitter } = require('events');

class ErrsoleMySQL extends EventEmitter {
  constructor (options = {}) {
    super();
    if (!options.logging) options.logging = false;

    this.name = require('../package.json').name;
    this.version = require('../package.json').version || '0.0.0';
    this.isConnectionInProgress = true;

    this.pool = mysql.createPool({
      host: options.host,
      user: options.username,
      password: options.password,
      database: options.database
    });

    this.initialize();
  }

  async initialize () {
    await this.checkConnection();
    await this.defineModels();
    this.ensureLogsTTL();
    // this.setBufferSizes();
    this.emit('ready');
  }

  async checkConnection () {
    const self = this;
    return new Promise((resolve, reject) => {
      self.pool.getConnection((err, connection) => {
        if (err) {
          console.error('Failed to get connection:', err);
          return reject(err);
        }
        connection.release();
        resolve();
      });
    });
  }

  async defineModels () {
    const queries = [
      `CREATE TABLE IF NOT EXISTS \`errsole_logs\` (
        \`id\` BIGINT PRIMARY KEY AUTO_INCREMENT,
        \`hostname\` VARCHAR(255),
        \`pid\` INT,
        \`source\` VARCHAR(255),
        \`timestamp\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`level\` VARCHAR(255) DEFAULT 'info',
        \`message\` TEXT,
        \`meta\` TEXT,
        INDEX (\`source\`, \`level\`, \`id\`),
        INDEX (\`source\`, \`level\`, \`timestamp\`),
        INDEX (\`hostname\`, \`pid\`, \`id\`)
      )`,
      `CREATE TABLE IF NOT EXISTS \`errsole_users\` (
        \`id\` BIGINT PRIMARY KEY AUTO_INCREMENT,
        \`name\` VARCHAR(255),
        \`email\` VARCHAR(255) UNIQUE NOT NULL,
        \`hashed_password\` VARCHAR(255) NOT NULL,
        \`role\` VARCHAR(255) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS \`errsole_config\` (
        \`id\` BIGINT PRIMARY KEY AUTO_INCREMENT,
        \`key\` VARCHAR(255) UNIQUE NOT NULL,
        \`value\` VARCHAR(255) NOT NULL
      )`
    ];

    let remainingQueries = queries.length;

    queries.forEach((query) => {
      this.pool.query(query, (err, results) => {
        if (err) {
          console.error(err);
        }
        remainingQueries--;
        if (remainingQueries === 0) {
          this.isConnectionInProgress = false;
        }
      });
    });
  }

  async getConfig (key) {
    const query = 'SELECT * FROM errsole_config WHERE `key` = ?';
    return new Promise((resolve, reject) => {
      this.pool.query(query, [key], (err, results) => {
        if (err) return reject(err);
        resolve({ item: results[0] });
      });
    });
  }

  async setConfig (key, value) {
    const query = 'INSERT INTO errsole_config (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)';
    return new Promise((resolve, reject) => {
      this.pool.query(query, [key, value], (err) => {
        if (err) return reject(err);
        this.getConfig(key).then(resolve).catch(reject);
      });
    });
  }

  async deleteConfig (key) {
    const query = 'DELETE FROM errsole_config WHERE `key` = ?';
    return new Promise((resolve, reject) => {
      this.pool.query(query, [key], (err, results) => {
        if (err) return reject(err);
        if (results.affectedRows === 0) return reject(new Error('Configuration not found.'));
        resolve({});
      });
    });
  }

  async postLogs (logEntries) {
    while (this.isConnectionInProgress) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const values = logEntries.map(logEntry => [
      logEntry.hostname,
      logEntry.pid,
      logEntry.source,
      logEntry.level,
      logEntry.message,
      logEntry.meta
    ]);

    const query = 'INSERT INTO errsole_logs (hostname, pid, source, level, message, meta) VALUES ?';

    process.nextTick(() => {
      this.pool.getConnection((err, connection) => {
        if (err) {
          setImmediate(() => {
            this.emit('error', err);
          });
          return;
        }
        // connection.query('INSERT INTO errsole_logs (hostname, pid, source, timestamp, level, message, meta) VALUES (\'Rishis-MacBook-Air.local\', 93315, \'console\', \'2024-06-14 12:12:12\', \'info\', \'Hello World.\', \'\')', (err, results, fields) => {
        connection.query(query, [values], (err) => {
          if (err) {
            setImmediate(() => {
              this.emit('error', err);
            });
          } else {
            // Query executed successfully
          }
          connection.release();
        });
      });
    });
  }

  async getLogs (filters = {}) {
    const whereClauses = [];
    const values = [];
    const defaultLimit = 100;
    filters.limit = filters.limit || defaultLimit;
    let sortOrder = 'DESC';
    let shouldReverse = true;

    // Apply filters
    if (filters.hostname) {
      whereClauses.push('hostname = ?');
      values.push(filters.hostname);
    }
    if (filters.pid) {
      whereClauses.push('pid = ?');
      values.push(filters.pid);
    }
    if (filters.sources && filters.sources.length > 0) {
      whereClauses.push('source IN (?)');
      values.push(filters.sources);
    }
    if (filters.levels && filters.levels.length > 0) {
      whereClauses.push('level IN (?)');
      values.push(filters.levels);
    }
    if (filters.level_json && filters.level_json.length > 0) {
      const levelConditions = filters.level_json.map(levelObj => '(source = ? AND level = ?)');
      whereClauses.push(`(${levelConditions.join(' OR ')})`);
      filters.level_json.forEach(levelObj => {
        values.push(levelObj.source, levelObj.level);
      });
    }
    if (filters.lt_id) {
      whereClauses.push('id < ?');
      values.push(filters.lt_id);
      sortOrder = 'DESC';
      shouldReverse = true;
    } else if (filters.gt_id) {
      whereClauses.push('id > ?');
      values.push(filters.gt_id);
      sortOrder = 'ASC';
      shouldReverse = false;
    } else if (filters.lte_timestamp || filters.gte_timestamp) {
      if (filters.lte_timestamp) {
        whereClauses.push('timestamp <= ?');
        values.push(new Date(filters.lte_timestamp));
        sortOrder = 'DESC';
        shouldReverse = true;
      }
      if (filters.gte_timestamp) {
        whereClauses.push('timestamp >= ?');
        values.push(new Date(filters.gte_timestamp));
        sortOrder = 'ASC';
        shouldReverse = false;
      }
    }

    const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const query = `SELECT id, hostname, pid, source, timestamp, level, message FROM errsole_logs ${whereClause} ORDER BY id ${sortOrder} LIMIT ?`;
    values.push(filters.limit);

    return new Promise((resolve, reject) => {
      this.pool.query(query, values, (err, results) => {
        if (err) return reject(err);
        if (shouldReverse) results.reverse();
        resolve({ items: results });
      });
    });
  }

  async searchLogs (searchTerms, filters = {}) {
    const whereClauses = searchTerms.map(() => 'message LIKE ?');
    const values = searchTerms.map(term => `%${term}%`);
    filters.limit = filters.limit || 100;

    if (filters.hostname) {
      whereClauses.push('hostname = ?');
      values.push(filters.hostname);
    }
    if (filters.pid) {
      whereClauses.push('pid = ?');
      values.push(filters.pid);
    }
    if (filters.sources) {
      whereClauses.push('source IN (?)');
      values.push(filters.sources);
    }
    if (filters.levels) {
      whereClauses.push('level IN (?)');
      values.push(filters.levels);
    }
    if (filters.level_json) {
      filters.level_json.forEach(levelObj => {
        whereClauses.push('(source = ? AND level = ?)');
        values.push(levelObj.source, levelObj.level);
      });
    }
    if (filters.lt_id) {
      whereClauses.push('id < ?');
      values.push(filters.lt_id);
    } else if (filters.gt_id) {
      whereClauses.push('id > ?');
      values.push(filters.gt_id);
    } else if (filters.lte_timestamp || filters.gte_timestamp) {
      if (filters.lte_timestamp) {
        whereClauses.push('timestamp <= ?');
        values.push(new Date(filters.lte_timestamp));
      }
      if (filters.gte_timestamp) {
        whereClauses.push('timestamp >= ?');
        values.push(new Date(filters.gte_timestamp));
      }
    }

    const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const query = `SELECT id, hostname, pid, source, timestamp, level, message FROM errsole_logs ${whereClause} ORDER BY id DESC LIMIT ?`;
    values.push(filters.limit);

    return new Promise((resolve, reject) => {
      this.pool.query(query, values, (err, results) => {
        if (err) return reject(err);
        resolve({ items: results });
      });
    });
  }

  async getMeta (id) {
    const query = 'SELECT id, meta FROM errsole_logs WHERE id = ?';
    return new Promise((resolve, reject) => {
      this.pool.query(query, [id], (err, results) => {
        if (err) return reject(err);
        if (!results.length) return reject(new Error('Log entry not found.'));
        resolve({ item: results[0] });
      });
    });
  }

  async ensureLogsTTL () {
    const DEFAULT_TTL = 2592000000;
    try {
      const configResult = await this.getConfig('logsTTL');
      if (!configResult.item) {
        await this.setConfig('logsTTL', DEFAULT_TTL.toString());
      }
      this.deleteExpiredLogs();
    } catch {}
  }

  async deleteExpiredLogs () {
    try {
      const configResult = await this.getConfig('logsTTL');
      if (!configResult.item) {
        throw new Error('Could not find the TTL configuration for logs.');
      }

      const logsTTL = parseInt(configResult.item.value, 10);
      const expirationTime = new Date(Date.now() - logsTTL).toISOString().slice(0, 19).replace('T', ' ');

      while (true) {
        const query = 'DELETE FROM errsole_logs WHERE timestamp < ? LIMIT 1000';
        const [results] = await this.pool.query(query, [expirationTime]);
        const deletedRowCount = results.affectedRows;
        const delayTime = deletedRowCount ? 1000 : 3600000; // 1 second if rows were deleted, otherwise 1 hour
        if (deletedRowCount === 0) break; // Exit loop if no rows were deleted
        await this.delay(delayTime);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async delay (ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async createUser (user) {
    const SALT_ROUNDS = 10;
    const hashedPassword = await bcrypt.hash(user.password, SALT_ROUNDS);
    const query = 'INSERT INTO errsole_users (name, email, hashed_password, role) VALUES (?, ?, ?, ?)';
    return new Promise((resolve, reject) => {
      this.pool.query(query, [user.name, user.email, hashedPassword, user.role], (err, results) => {
        if (err) {
          if (err.code === 'ER_DUP_ENTRY') return reject(new Error('A user with the provided email already exists.'));
          return reject(err);
        }
        resolve({ item: { id: results.insertId, name: user.name, email: user.email, role: user.role } });
      });
    });
  }

  async verifyUser (email, password) {
    if (!email || !password) throw new Error('Both email and password are required for verification.');

    const query = 'SELECT * FROM errsole_users WHERE email = ?';
    return new Promise((resolve, reject) => {
      this.pool.query(query, [email], async (err, results) => {
        if (err) return reject(err);
        if (!results.length) return reject(new Error('User not found.'));

        const user = results[0];
        const isPasswordCorrect = await bcrypt.compare(password, user.hashed_password);
        if (!isPasswordCorrect) return reject(new Error('Incorrect password.'));

        delete user.hashed_password;
        resolve({ item: user });
      });
    });
  }

  async getUserCount () {
    const query = 'SELECT COUNT(*) as count FROM errsole_users';
    return new Promise((resolve, reject) => {
      this.pool.query(query, (err, results) => {
        if (err) return reject(err);
        resolve({ count: results[0].count });
      });
    });
  }

  async getAllUsers () {
    const query = 'SELECT id, name, email, role FROM errsole_users';
    return new Promise((resolve, reject) => {
      this.pool.query(query, (err, results) => {
        if (err) return reject(err);
        resolve({ items: results });
      });
    });
  }

  async getUserByEmail (email) {
    if (!email) throw new Error('Email is required.');

    const query = 'SELECT id, name, email, role FROM errsole_users WHERE email = ?';
    return new Promise((resolve, reject) => {
      this.pool.query(query, [email], (err, results) => {
        if (err) return reject(err);
        if (!results.length) return reject(new Error('User not found.'));
        resolve({ item: results[0] });
      });
    });
  }

  async updateUserByEmail (email, updates) {
    if (!email) throw new Error('Email is required.');
    if (!updates || Object.keys(updates).length === 0) throw new Error('No updates provided.');

    const restrictedFields = ['id', 'hashed_password'];
    restrictedFields.forEach(field => delete updates[field]);

    const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), email];

    const query = `UPDATE errsole_users SET ${setClause} WHERE email = ?`;
    return new Promise((resolve, reject) => {
      this.pool.query(query, values, async (err, results) => {
        if (err) return reject(err);
        if (results.affectedRows === 0) return reject(new Error('No updates applied.'));
        this.getUserByEmail(email).then(resolve).catch(reject);
      });
    });
  }

  async updatePassword (email, currentPassword, newPassword) {
    if (!email || !currentPassword || !newPassword) throw new Error('Email, current password, and new password are required.');

    const query = 'SELECT * FROM errsole_users WHERE email = ?';
    return new Promise((resolve, reject) => {
      this.pool.query(query, [email], async (err, results) => {
        if (err) return reject(err);
        if (!results.length) return reject(new Error('User not found.'));

        const user = results[0];
        const isPasswordCorrect = await bcrypt.compare(currentPassword, user.hashed_password);
        if (!isPasswordCorrect) return reject(new Error('Current password is incorrect.'));

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const updateQuery = 'UPDATE errsole_users SET hashed_password = ? WHERE email = ?';
        this.pool.query(updateQuery, [hashedPassword, email], (err, updateResults) => {
          if (err) return reject(err);
          if (updateResults.affectedRows === 0) return reject(new Error('Password update failed.'));
          delete user.hashed_password;
          resolve({ item: user });
        });
      });
    });
  }

  async deleteUser (userId) {
    if (!userId) throw new Error('User ID is required.');

    const query = 'DELETE FROM errsole_users WHERE id = ?';
    return new Promise((resolve, reject) => {
      this.pool.query(query, [userId], (err, results) => {
        if (err) return reject(err);
        if (results.affectedRows === 0) return reject(new Error('User not found.'));
        resolve({});
      });
    });
  }

  async getBufferSize () {
    const query = "SHOW VARIABLES LIKE 'sort_buffer_size'";
    return new Promise((resolve, reject) => {
      this.pool.query(query, (err, results) => {
        if (err) return reject(err);
        resolve(parseInt(results[0].Value, 10));
      });
    });
  }

  async setBufferSizes () {
    const desiredSize = 8 * 1024 * 1024; // 8 MB in bytes
    const currentSize = await this.getBufferSize();

    if (currentSize < desiredSize) {
      const query = 'SET SESSION sort_buffer_size = 8388608'; // Set for the session
      return new Promise((resolve, reject) => {
        this.pool.query(query, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }
  }
}

module.exports = ErrsoleMySQL;
