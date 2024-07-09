const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const ErrsoleMySQL = require('../lib/index'); // Adjust the path as needed
const { describe } = require('@jest/globals');

/* globals expect, jest, beforeEach, it, afterEach */

jest.mock('mysql2', () => ({
  createPool: jest.fn()
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn(),
  compare: jest.fn()
}));

describe('ErrsoleMySQL', () => {
  let errsoleMySQL;
  let poolMock;
  let connectionMock;
  let originalConsoleError;

  beforeEach(() => {
    connectionMock = {
      query: jest.fn(),
      release: jest.fn()
    };

    poolMock = {
      getConnection: jest.fn().mockImplementation((cb) => cb(null, connectionMock)),
      query: jest.fn()
    };

    mysql.createPool.mockReturnValue(poolMock);
    errsoleMySQL = new ErrsoleMySQL({
      host: 'localhost',
      user: 'username',
      password: 'password',
      database: 'errsole_db',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    // Suppress console.error
    originalConsoleError = console.error;
    console.error = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();

    // Restore console.error
    console.error = originalConsoleError;
  });

  describe('initialize', () => {
    it('should initialize properly', async () => {
      poolMock.getConnection.mockImplementation((cb) => cb(null, { release: jest.fn() }));
      poolMock.query.mockImplementation((query, cb) => cb(null, [{ Value: '8388608' }]));

      await errsoleMySQL.initialize();

      expect(poolMock.getConnection).toHaveBeenCalled();
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.any(Function));
      expect(errsoleMySQL.isConnectionInProgress).toBe(false);
    });
  });

  describe('checkConnection', () => {
    it('should resolve if connection is successful', async () => {
      poolMock.getConnection.mockImplementation((cb) => cb(null, { release: jest.fn() }));

      await expect(errsoleMySQL.checkConnection()).resolves.toBeUndefined();
    });

    it('should reject if connection fails', async () => {
      poolMock.getConnection.mockImplementation((cb) => cb(new Error('Connection error')));

      await expect(errsoleMySQL.checkConnection()).rejects.toThrow('Connection error');
    });
  });

  describe('createTables', () => {
    it('should create tables if they do not exist', async () => {
      poolMock.query.mockImplementation((query, cb) => cb(null, { affectedRows: 1 }));

      await errsoleMySQL.createTables();

      expect(poolMock.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS `errsole_logs_v1`'), expect.any(Function));
      expect(poolMock.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS `errsole_users`'), expect.any(Function));
      expect(poolMock.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS `errsole_config`'), expect.any(Function));
    });
  });

  describe('getConfig', () => {
    it('should retrieve config', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [{ key: 'logsTTL', value: '2592000000' }]));

      const config = await errsoleMySQL.getConfig('logsTTL');

      expect(config).toEqual({ item: { key: 'logsTTL', value: '2592000000' } });
    });
  });

  describe('deleteConfig', () => {
    it('should delete config', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, { affectedRows: 1 }));

      await errsoleMySQL.deleteConfig('logsTTL');

      expect(poolMock.query).toHaveBeenCalledWith('DELETE FROM errsole_config WHERE `key` = ?', ['logsTTL'], expect.any(Function));
    });

    it('should throw error if config not found', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, { affectedRows: 0 }));

      await expect(errsoleMySQL.deleteConfig('logsTTL')).rejects.toThrow('Configuration not found.');
    });
  });

  describe('postLogs', () => {
    it('should add log entries to pending logs', async () => {
      const logEntries = [
        { timestamp: new Date(), hostname: 'localhost', pid: 1234, source: 'test', level: 'info', message: 'test message', meta: 'meta' }
      ];
      errsoleMySQL.postLogs(logEntries);

      expect(errsoleMySQL.pendingLogs).toHaveLength(1);
      expect(errsoleMySQL.pendingLogs[0]).toEqual(logEntries[0]);
    });

    it('should call flushLogs if pending logs exceed batch size', async () => {
      const logEntries = Array.from({ length: errsoleMySQL.batchSize + 1 }, (_, i) => ({
        timestamp: new Date(),
        hostname: 'localhost',
        pid: 1234,
        source: 'test',
        level: 'info',
        message: `test message ${i}`,
        meta: 'meta'
      }));

      const flushLogsSpy = jest.spyOn(errsoleMySQL, 'flushLogs').mockImplementation(() => Promise.resolve({}));

      errsoleMySQL.postLogs(logEntries);

      expect(flushLogsSpy).toHaveBeenCalled();
    });
  });

  describe('getLogs', () => {
    it('should retrieve log entries', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }]));

      const logs = await errsoleMySQL.getLogs();

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }] });
    }, 10000); // Extend timeout to 10 seconds
  });

  describe('searchLogs', () => {
    it('should search log entries', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }]));

      const logs = await errsoleMySQL.searchLogs(['test']);

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }] });
    }, 10000); // Extend timeout to 10 seconds
  });

  describe('getMeta', () => {
    it('should retrieve meta data for a log entry', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [{ id: 1, meta: 'meta data' }]));

      const meta = await errsoleMySQL.getMeta(1);

      expect(meta).toEqual({ item: { id: 1, meta: 'meta data' } });
    });
  });

  describe('createUser', () => {
    it('should create a new user', async () => {
      const mockHashedPassword = 'hashedPassword';
      bcrypt.hash.mockResolvedValue(mockHashedPassword);
      poolMock.query.mockImplementation((query, values, cb) => cb(null, { insertId: 1 }));

      const user = await errsoleMySQL.createUser({ name: 'test', email: 'test@example.com', password: 'password', role: 'admin' });

      expect(user).toEqual({ item: { id: 1, name: 'test', email: 'test@example.com', role: 'admin' } });
    });

    it('should throw error if email already exists', async () => {
      const mockHashedPassword = 'hashedPassword';
      bcrypt.hash.mockResolvedValue(mockHashedPassword);
      poolMock.query.mockImplementation((query, values, cb) => cb(Object.assign(new Error('A user with the provided email already exists.'), { code: 'ER_DUP_ENTRY' })));

      await expect(errsoleMySQL.createUser({ name: 'test', email: 'test@example.com', password: 'password', role: 'admin' })).rejects.toThrow('A user with the provided email already exists.');
    });

    it('should handle query errors', async () => {
      const mockHashedPassword = 'hashedPassword';
      bcrypt.hash.mockResolvedValue(mockHashedPassword);
      poolMock.query.mockImplementation((query, values, cb) => cb(new Error('Query error')));

      await expect(errsoleMySQL.createUser({ name: 'test', email: 'test@example.com', password: 'password', role: 'admin' })).rejects.toThrow('Query error');
    });
  });

  describe('verifyUser', () => {
    it('should throw an error if email or password is missing', async () => {
      await expect(errsoleMySQL.verifyUser('', 'password')).rejects.toThrow('Both email and password are required for verification.');
      await expect(errsoleMySQL.verifyUser('test@example.com', '')).rejects.toThrow('Both email and password are required for verification.');
    });

    it('should verify user credentials', async () => {
      const user = { id: 1, name: 'test', email: 'test@example.com', hashed_password: 'hashedPassword', role: 'admin' };
      bcrypt.compare.mockResolvedValue(true);
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [user]));

      const result = await errsoleMySQL.verifyUser('test@example.com', 'password');

      expect(result).toEqual({ item: { id: 1, name: 'test', email: 'test@example.com', role: 'admin' } });
      expect(poolMock.query).toHaveBeenCalledWith('SELECT * FROM errsole_users WHERE email = ?', ['test@example.com'], expect.any(Function));
      expect(bcrypt.compare).toHaveBeenCalledWith('password', 'hashedPassword');
    });

    it('should throw an error if user is not found', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, []));

      await expect(errsoleMySQL.verifyUser('test@example.com', 'password')).rejects.toThrow('User not found.');
      expect(poolMock.query).toHaveBeenCalledWith('SELECT * FROM errsole_users WHERE email = ?', ['test@example.com'], expect.any(Function));
    });

    it('should throw an error if password is incorrect', async () => {
      const user = { id: 1, name: 'test', email: 'test@example.com', hashed_password: 'hashedPassword', role: 'admin' };
      bcrypt.compare.mockResolvedValue(false);
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [user]));

      await expect(errsoleMySQL.verifyUser('test@example.com', 'wrongPassword')).rejects.toThrow('Incorrect password.');
      expect(poolMock.query).toHaveBeenCalledWith('SELECT * FROM errsole_users WHERE email = ?', ['test@example.com'], expect.any(Function));
      expect(bcrypt.compare).toHaveBeenCalledWith('wrongPassword', 'hashedPassword');
    });

    it('should handle query errors', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(new Error('Query error')));

      await expect(errsoleMySQL.verifyUser('test@example.com', 'password')).rejects.toThrow('Query error');
    });
  });

  describe('getUserCount', () => {
    it('should retrieve user count', async () => {
      poolMock.query.mockImplementation((query, cb) => cb(null, [{ count: 10 }]));

      const count = await errsoleMySQL.getUserCount();

      expect(count).toEqual({ count: 10 });
    });
  });

  describe('getAllUsers', () => {
    it('should retrieve all users', async () => {
      poolMock.query.mockImplementation((query, cb) => cb(null, [{ id: 1, name: 'test', email: 'test@example.com', role: 'admin' }]));

      const users = await errsoleMySQL.getAllUsers();

      expect(users).toEqual({ items: [{ id: 1, name: 'test', email: 'test@example.com', role: 'admin' }] });
    });
  });

  describe('getUserByEmail', () => {
    it('should retrieve user by email', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [{ id: 1, name: 'test', email: 'test@example.com', role: 'admin' }]));

      const user = await errsoleMySQL.getUserByEmail('test@example.com');

      expect(user).toEqual({ item: { id: 1, name: 'test', email: 'test@example.com', role: 'admin' } });
    });

    it('should throw error if user not found', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, []));

      await expect(errsoleMySQL.getUserByEmail('test@example.com')).rejects.toThrow(new Error('User not found.'));
    });
  });

  describe('updateUserByEmail', () => {
    it('should throw error if no updates applied', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, { affectedRows: 0 }));

      await expect(errsoleMySQL.updateUserByEmail('test@example.com', { name: 'updated' })).rejects.toThrow(new Error('No updates applied.'));
    });
  });

  describe('updatePassword', () => {
    it('should update user password', async () => {
      bcrypt.compare.mockResolvedValue(true);
      bcrypt.hash.mockResolvedValue('newHashedPassword');
      poolMock.query.mockImplementation((query, values, cb) => {
        if (query.includes('SELECT')) {
          cb(null, [{ id: 1, name: 'test', email: 'test@example.com', hashed_password: 'hashedPassword', role: 'admin' }]);
        } else {
          cb(null, { affectedRows: 1 });
        }
      });

      const user = await errsoleMySQL.updatePassword('test@example.com', 'password', 'newPassword');

      expect(user).toEqual({ item: { id: 1, name: 'test', email: 'test@example.com', role: 'admin' } });
    });

    it('should throw error if current password is incorrect', async () => {
      bcrypt.compare.mockResolvedValue(false);
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [{ id: 1, name: 'test', email: 'test@example.com', hashed_password: 'hashedPassword', role: 'admin' }]));

      await expect(errsoleMySQL.updatePassword('test@example.com', 'wrongPassword', 'newPassword')).rejects.toThrow(new Error('Current password is incorrect.'));
    });
  });

  describe('deleteUser', () => {
    it('should delete user by id', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, { affectedRows: 1 }));

      await errsoleMySQL.deleteUser(1);

      expect(poolMock.query).toHaveBeenCalledWith('DELETE FROM errsole_users WHERE id = ?', [1], expect.any(Function));
    });

    it('should throw error if user not found', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, { affectedRows: 0 }));

      await expect(errsoleMySQL.deleteUser(1)).rejects.toThrow(new Error('User not found.'));
    });
  });

  describe('getMeta', () => {
    it('should retrieve meta data for a log entry', async () => {
      poolMock.query.mockImplementation((query, values, cb) => {
        expect(query).toContain('SELECT id, meta FROM errsole_logs_v1 WHERE id = ?');
        expect(values).toEqual([1]);
        cb(null, [{ id: 1, meta: 'meta data' }]);
      });

      const meta = await errsoleMySQL.getMeta(1);

      expect(meta).toEqual({ item: { id: 1, meta: 'meta data' } });
    });

    it('should throw an error if log entry is not found', async () => {
      poolMock.query.mockImplementation((query, values, cb) => {
        expect(query).toContain('SELECT id, meta FROM errsole_logs_v1 WHERE id = ?');
        expect(values).toEqual([1]);
        cb(null, []);
      });

      await expect(errsoleMySQL.getMeta(1)).rejects.toThrow('Log entry not found.');
    });

    it('should handle query errors', async () => {
      poolMock.query.mockImplementation((query, values, cb) => {
        expect(query).toContain('SELECT id, meta FROM errsole_logs_v1 WHERE id = ?');
        expect(values).toEqual([1]);
        cb(new Error('Query error'));
      });

      await expect(errsoleMySQL.getMeta(1)).rejects.toThrow('Query error');
    });
  });
});
