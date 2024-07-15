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

  describe('#initialize', () => {
    it('should initialize properly', async () => {
      poolMock.getConnection.mockImplementation((cb) => cb(null, { release: jest.fn() }));
      poolMock.query.mockImplementation((query, values, cb) => {
        if (typeof values === 'function') {
          cb = values;
          values = null;
        }
        cb(null, [{ Value: '8388608' }]);
      });

      await errsoleMySQL.initialize();

      expect(poolMock.getConnection).toHaveBeenCalled();
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.any(Function));
      expect(errsoleMySQL.isConnectionInProgress).toBe(false);
    });
  });

  describe('#checkConnection', () => {
    it('should resolve if connection is successful', async () => {
      poolMock.getConnection.mockImplementation((cb) => cb(null, { release: jest.fn() }));

      await expect(errsoleMySQL.checkConnection()).resolves.toBeUndefined();
    });

    it('should reject if connection fails', async () => {
      poolMock.getConnection.mockImplementation((cb) => cb(new Error('Connection error')));

      await expect(errsoleMySQL.checkConnection()).rejects.toThrow('Connection error');
    });
  });

  describe('#getBufferSize', () => {
    it('should retrieve the current buffer size', async () => {
      poolMock.query.mockImplementation((query, cb) => cb(null, [{ Value: '8388608' }]));

      const size = await errsoleMySQL.getBufferSize();

      expect(size).toBe(8388608);
    });

    it('should handle errors in retrieving buffer size', async () => {
      poolMock.query.mockImplementation((query, cb) => cb(new Error('Query error')));

      await expect(errsoleMySQL.getBufferSize()).rejects.toThrow('Query error');
    });
  });

  describe('#setBufferSize', () => {
    it('should set buffer sizes if current size is less than desired size', async () => {
      jest.spyOn(errsoleMySQL, 'getBufferSize').mockResolvedValue(1024 * 1024); // 1 MB
      poolMock.query.mockImplementation((query, cb) => cb(null, {}));

      await errsoleMySQL.setBufferSize();

      expect(poolMock.query).toHaveBeenCalledWith('SET SESSION sort_buffer_size = 8388608', expect.any(Function));
    });

    it('should not set buffer sizes if current size is greater than or equal to desired size', async () => {
      jest.spyOn(errsoleMySQL, 'getBufferSize').mockResolvedValue(8 * 1024 * 1024); // 8 MB

      await errsoleMySQL.setBufferSize();

      expect(poolMock.query).not.toHaveBeenCalledWith('SET SESSION sort_buffer_size = 8388608', expect.any(Function));
    });
  });

  describe('#createTables', () => {
    it('should create tables if they do not exist', async () => {
      poolMock.query.mockImplementation((query, cb) => cb(null, { affectedRows: 1 }));

      await errsoleMySQL.createTables();

      expect(poolMock.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS `errsole_logs_v1`'), expect.any(Function));
      expect(poolMock.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS `errsole_users`'), expect.any(Function));
      expect(poolMock.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS `errsole_config`'), expect.any(Function));
    });

    it('should handle errors in table creation', async () => {
      poolMock.query.mockImplementation((query, cb) => cb(new Error('Query error')));

      await expect(errsoleMySQL.createTables()).rejects.toThrow('Query error');
    });
  });

  describe('#getConfig', () => {
    it('should retrieve a configuration based on the provided key', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [{ key: 'testKey', value: 'testValue' }]));

      const config = await errsoleMySQL.getConfig('testKey');

      expect(config).toEqual({ item: { key: 'testKey', value: 'testValue' } });
      expect(poolMock.query).toHaveBeenCalledWith('SELECT * FROM errsole_config WHERE `key` = ?', ['testKey'], expect.any(Function));
    });

    it('should handle errors during the query execution', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(new Error('Query error')));

      await expect(errsoleMySQL.getConfig('testKey')).rejects.toThrow('Query error');
      expect(poolMock.query).toHaveBeenCalledWith('SELECT * FROM errsole_config WHERE `key` = ?', ['testKey'], expect.any(Function));
    });
  });

  describe('#setConfig', () => {
    it('should update an existing configuration', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, { affectedRows: 1 }));
      jest.spyOn(errsoleMySQL, 'getConfig').mockResolvedValue({ item: { key: 'logsTTL', value: '2592000000' } });

      const config = await errsoleMySQL.setConfig('logsTTL', '2592000000');

      expect(poolMock.query).toHaveBeenCalledWith(
        'INSERT INTO errsole_config (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
        ['logsTTL', '2592000000'],
        expect.any(Function)
      );
      expect(config).toEqual({ item: { key: 'logsTTL', value: '2592000000' } });
    });

    it('should insert a new configuration if it does not exist', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, { affectedRows: 1 }));
      jest.spyOn(errsoleMySQL, 'getConfig').mockResolvedValue({ item: { key: 'newKey', value: 'newValue' } });

      const config = await errsoleMySQL.setConfig('newKey', 'newValue');

      expect(poolMock.query).toHaveBeenCalledWith(
        'INSERT INTO errsole_config (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
        ['newKey', 'newValue'],
        expect.any(Function)
      );
      expect(config).toEqual({ item: { key: 'newKey', value: 'newValue' } });
    });

    it('should handle errors in setting configuration', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(new Error('Query error')));

      await expect(errsoleMySQL.setConfig('newKey', 'newValue')).rejects.toThrow('Query error');
    });
  });

  describe('#deleteConfig', () => {
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

  describe('#postLogs', () => {
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

  describe('#getLogs', () => {
    it('should retrieve log entries without filters', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.getLogs();

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }] });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), [100], expect.any(Function));
    });

    it('should retrieve log entries with hostname filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.getLogs({ hostname: 'localhost' });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }] });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), ['localhost', 100], expect.any(Function));
    });

    it('should retrieve log entries with pid filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.getLogs({ pid: 1234 });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }] });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), [1234, 100], expect.any(Function));
    });

    it('should retrieve log entries with sources filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.getLogs({ sources: ['test'] });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }] });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), [['test'], 100], expect.any(Function));
    });

    it('should retrieve log entries with levels filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.getLogs({ levels: ['info'] });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }] });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), [['info'], 100], expect.any(Function));
    });

    it('should retrieve log entries with level_json filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.getLogs({ level_json: [{ source: 'test', level: 'info' }] });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }] });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), ['test', 'info', 100], expect.any(Function));
    });

    it('should retrieve log entries with lt_id filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.getLogs({ lt_id: 2 });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }] });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), [2, 100], expect.any(Function));
    });

    it('should retrieve log entries with gt_id filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 3, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.getLogs({ gt_id: 2 });

      expect(logs).toEqual({ items: [{ id: 3, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }] });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), [2, 100], expect.any(Function));
    });

    it('should retrieve log entries with date filters', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.getLogs({ lte_timestamp: new Date('2023-01-02'), gte_timestamp: new Date('2023-01-01') });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }] });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), [new Date('2023-01-02'), new Date('2023-01-01'), 100], expect.any(Function));
    });

    it('should handle errors in retrieving logs', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(new Error('Query error')));

      await expect(errsoleMySQL.getLogs()).rejects.toThrow('Query error');
    });
  });

  describe('#searchLogs', () => {
    afterEach(() => {
      jest.clearAllMocks();
    });

    it('should search log entries based on search terms without filters', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.searchLogs(['test']);

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }], filters: { limit: 100 } });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['%test%']), expect.any(Function));
    });

    it('should search log entries with hostname filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.searchLogs(['test'], { hostname: 'localhost' });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }], filters: { hostname: 'localhost', limit: 100 } });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['%test%', 'localhost']), expect.any(Function));
    });

    it('should search log entries with pid filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.searchLogs(['test'], { pid: 1234 });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }], filters: { pid: 1234, limit: 100 } });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['%test%', 1234]), expect.any(Function));
    });

    it('should search log entries with sources filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.searchLogs(['test'], { sources: ['test'] });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }], filters: { sources: ['test'], limit: 100 } });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['%test%', ['test']]), expect.any(Function));
    });

    it('should search log entries with levels filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.searchLogs(['test'], { levels: ['info'] });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }], filters: { levels: ['info'], limit: 100 } });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['%test%', ['info']]), expect.any(Function));
    });

    it('should search log entries with level_json filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.searchLogs(['test'], { level_json: [{ source: 'test', level: 'info' }] });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }], filters: { level_json: [{ source: 'test', level: 'info' }], limit: 100 } });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['%test%', 'test', 'info']), expect.any(Function));
    });

    it('should search log entries with lt_id filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.searchLogs(['test'], { lt_id: 2 });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }], filters: { lt_id: 2, limit: 100 } });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['%test%', 2, 100]), expect.any(Function));
    });

    it('should search log entries with gt_id filter', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 3, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.searchLogs(['test'], { gt_id: 2 });

      expect(logs).toEqual({ items: [{ id: 3, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }], filters: { gt_id: 2, limit: 100 } });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['%test%', 2, 100]), expect.any(Function));
    });

    it('should search log entries with date filters', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.searchLogs(['test'], { lte_timestamp: new Date('2023-01-02'), gte_timestamp: new Date('2023-01-01') });

      expect(logs).toEqual({ items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }], filters: { lte_timestamp: new Date('2023-01-02'), gte_timestamp: new Date('2023-01-01'), limit: 100 } });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['%test%', new Date('2023-01-02'), new Date('2023-01-01'), 100]), expect.any(Function));
    });

    it('should search log entries with only lte_timestamp', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.searchLogs(['test'], { lte_timestamp: new Date('2023-01-02') });

      expect(logs).toEqual({
        items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }],
        filters: { lte_timestamp: new Date('2023-01-02'), gte_timestamp: new Date('2023-01-01'), limit: 100 }
      });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['%test%', new Date('2023-01-02'), new Date('2023-01-01'), 100]), expect.any(Function));
    });

    it('should search log entries with only gte_timestamp', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }
      ]));

      const logs = await errsoleMySQL.searchLogs(['test'], { gte_timestamp: new Date('2023-01-01') });

      expect(logs).toEqual({
        items: [{ id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: '2023-01-01 00:00:00', level: 'info', message: 'test message' }],
        filters: { gte_timestamp: new Date('2023-01-01'), lte_timestamp: new Date('2023-01-02'), limit: 100 }
      });
      expect(poolMock.query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['%test%', new Date('2023-01-02'), new Date('2023-01-01'), 100]), expect.any(Function));
    });

    it('should handle errors in searching logs', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(new Error('Query error')));

      await expect(errsoleMySQL.searchLogs(['test'])).rejects.toThrow('Query error');
    });
  });

  describe('#createUser', () => {
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

  describe('#verifyUser', () => {
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

  describe('#getUserCount', () => {
    it('should retrieve user count', async () => {
      poolMock.query.mockImplementation((query, cb) => cb(null, [{ count: 10 }]));

      const count = await errsoleMySQL.getUserCount();

      expect(count).toEqual({ count: 10 });
    });
  });

  describe('#getAllUsers', () => {
    it('should retrieve all users', async () => {
      poolMock.query.mockImplementation((query, cb) => cb(null, [{ id: 1, name: 'test', email: 'test@example.com', role: 'admin' }]));

      const users = await errsoleMySQL.getAllUsers();

      expect(users).toEqual({ items: [{ id: 1, name: 'test', email: 'test@example.com', role: 'admin' }] });
    });
  });

  describe('#getUserByEmail', () => {
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

  describe('#updateUserByEmail', () => {
    let getUserByEmailSpy;

    beforeEach(() => {
      getUserByEmailSpy = jest.spyOn(errsoleMySQL, 'getUserByEmail').mockResolvedValue({ item: { id: 1, name: 'updated', email: 'test@example.com', role: 'admin' } });
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('should update user by email', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, { affectedRows: 1 }));

      const user = await errsoleMySQL.updateUserByEmail('test@example.com', { name: 'updated' });

      expect(poolMock.query).toHaveBeenCalledWith(
        'UPDATE errsole_users SET name = ? WHERE email = ?',
        ['updated', 'test@example.com'],
        expect.any(Function)
      );
      expect(getUserByEmailSpy).toHaveBeenCalledWith('test@example.com');
      expect(user).toEqual({ item: { id: 1, name: 'updated', email: 'test@example.com', role: 'admin' } });
    });

    it('should throw an error if no email is provided', async () => {
      await expect(errsoleMySQL.updateUserByEmail('', { name: 'updated' })).rejects.toThrow('Email is required.');
    });

    it('should throw an error if no updates are provided', async () => {
      await expect(errsoleMySQL.updateUserByEmail('test@example.com', {})).rejects.toThrow('No updates provided.');
    });

    it('should handle errors if no updates are applied', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, { affectedRows: 0 }));

      await expect(errsoleMySQL.updateUserByEmail('test@example.com', { name: 'updated' })).rejects.toThrow('No updates applied.');
    });

    it('should handle query errors during user update', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(new Error('Query error')));

      await expect(errsoleMySQL.updateUserByEmail('test@example.com', { name: 'updated' })).rejects.toThrow('Query error');
    });
  });

  describe('#updatePassword', () => {
    afterEach(() => {
      jest.clearAllMocks();
    });

    it('should update user password', async () => {
      const user = { id: 1, name: 'test', email: 'test@example.com', hashed_password: 'hashedPassword', role: 'admin' };
      poolMock.query.mockImplementation((query, values, cb) => {
        if (query.includes('SELECT')) {
          cb(null, [user]);
        } else {
          cb(null, { affectedRows: 1 });
        }
      });
      bcrypt.compare.mockResolvedValue(true);
      bcrypt.hash.mockResolvedValue('newHashedPassword');

      const result = await errsoleMySQL.updatePassword('test@example.com', 'password', 'newPassword');

      expect(poolMock.query).toHaveBeenCalledWith('SELECT * FROM errsole_users WHERE email = ?', ['test@example.com'], expect.any(Function));
      expect(bcrypt.compare).toHaveBeenCalledWith('password', 'hashedPassword');
      expect(bcrypt.hash).toHaveBeenCalledWith('newPassword', 10);
      expect(poolMock.query).toHaveBeenCalledWith('UPDATE errsole_users SET hashed_password = ? WHERE email = ?', ['newHashedPassword', 'test@example.com'], expect.any(Function));
      expect(result).toEqual({ item: { id: 1, name: 'test', email: 'test@example.com', role: 'admin' } });
    });

    it('should throw an error if email, current password, or new password is missing', async () => {
      await expect(errsoleMySQL.updatePassword('', 'password', 'newPassword')).rejects.toThrow('Email, current password, and new password are required.');
      await expect(errsoleMySQL.updatePassword('test@example.com', '', 'newPassword')).rejects.toThrow('Email, current password, and new password are required.');
      await expect(errsoleMySQL.updatePassword('test@example.com', 'password', '')).rejects.toThrow('Email, current password, and new password are required.');
    });

    it('should throw an error if user is not found', async () => {
      poolMock.query.mockImplementation((query, values, cb) => cb(null, []));

      await expect(errsoleMySQL.updatePassword('test@example.com', 'password', 'newPassword')).rejects.toThrow('User not found.');
    });

    it('should throw an error if current password is incorrect', async () => {
      const user = { id: 1, name: 'test', email: 'test@example.com', hashed_password: 'hashedPassword', role: 'admin' };
      poolMock.query.mockImplementation((query, values, cb) => cb(null, [user]));
      bcrypt.compare.mockResolvedValue(false);

      await expect(errsoleMySQL.updatePassword('test@example.com', 'wrongPassword', 'newPassword')).rejects.toThrow('Current password is incorrect.');
    });

    it('should handle query errors during user password update', async () => {
      const user = { id: 1, name: 'test', email: 'test@example.com', hashed_password: 'hashedPassword', role: 'admin' };
      poolMock.query.mockImplementation((query, values, cb) => {
        if (query.includes('SELECT')) {
          cb(null, [user]);
        } else {
          cb(new Error('Query error'));
        }
      });
      bcrypt.compare.mockResolvedValue(true);
      bcrypt.hash.mockResolvedValue('newHashedPassword');

      await expect(errsoleMySQL.updatePassword('test@example.com', 'password', 'newPassword')).rejects.toThrow('Query error');
    });

    it('should throw an error if no updates are applied (affectedRows = 0)', async () => {
      const user = { id: 1, name: 'test', email: 'test@example.com', hashed_password: 'hashedPassword', role: 'admin' };
      poolMock.query.mockImplementation((query, values, cb) => {
        if (query.includes('SELECT')) {
          cb(null, [user]);
        } else {
          cb(null, { affectedRows: 0 });
        }
      });
      bcrypt.compare.mockResolvedValue(true);
      bcrypt.hash.mockResolvedValue('newHashedPassword');

      await expect(errsoleMySQL.updatePassword('test@example.com', 'password', 'newPassword')).rejects.toThrow('Password update failed.');
    });
  });

  describe('#deleteUser', () => {
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

  describe('#getMeta', () => {
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

  describe('#deleteExpiredLogs', () => {
    let getConfigSpy;
    let poolQuerySpy;
    let setTimeoutSpy;

    beforeEach(() => {
      getConfigSpy = jest.spyOn(errsoleMySQL, 'getConfig').mockResolvedValue({ item: { key: 'logsTTL', value: '2592000000' } });
      poolQuerySpy = jest.spyOn(poolMock, 'query');
      setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((callback) => callback());
      errsoleMySQL.deleteExpiredLogsRunning = false; // Reset the flag before each test
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('should delete expired logs based on TTL', async () => {
      poolQuerySpy
        .mockImplementationOnce((query, values, cb) => cb(null, { affectedRows: 1000 }))
        .mockImplementationOnce((query, values, cb) => cb(null, { affectedRows: 0 }));

      await errsoleMySQL.deleteExpiredLogs();

      expect(getConfigSpy).toHaveBeenCalledWith('logsTTL');
      expect(poolQuerySpy).toHaveBeenCalledWith(
        'DELETE FROM errsole_logs_v1 WHERE timestamp < ? LIMIT 1000',
        [expect.any(String)],
        expect.any(Function)
      );
      expect(setTimeoutSpy).toHaveBeenCalled();
    });

    it('should handle error in pool.query', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      poolQuerySpy.mockImplementationOnce((query, values, cb) => cb(new Error('Test error')));

      await errsoleMySQL.deleteExpiredLogs();

      expect(consoleErrorSpy).toHaveBeenCalledWith(new Error('Test error'));
      consoleErrorSpy.mockRestore();
    });

    it('should handle invalid TTL from config', async () => {
      getConfigSpy.mockResolvedValueOnce({ item: { key: 'logsTTL', value: 'invalid' } });
      poolQuerySpy
        .mockImplementationOnce((query, values, cb) => cb(null, { affectedRows: 1000 }))
        .mockImplementationOnce((query, values, cb) => cb(null, { affectedRows: 0 }));

      await errsoleMySQL.deleteExpiredLogs();

      expect(getConfigSpy).toHaveBeenCalledWith('logsTTL');
      expect(poolQuerySpy).toHaveBeenCalledWith(
        'DELETE FROM errsole_logs_v1 WHERE timestamp < ? LIMIT 1000',
        [expect.any(String)],
        expect.any(Function)
      );
      expect(setTimeoutSpy).toHaveBeenCalled();
    });

    it('should use default TTL if config is not found', async () => {
      getConfigSpy.mockResolvedValueOnce({ item: null });
      poolQuerySpy
        .mockImplementationOnce((query, values, cb) => cb(null, { affectedRows: 1000 }))
        .mockImplementationOnce((query, values, cb) => cb(null, { affectedRows: 0 }));

      await errsoleMySQL.deleteExpiredLogs();

      expect(getConfigSpy).toHaveBeenCalledWith('logsTTL');
      expect(poolQuerySpy).toHaveBeenCalledWith(
        'DELETE FROM errsole_logs_v1 WHERE timestamp < ? LIMIT 1000',
        [expect.any(String)],
        expect.any(Function)
      );
      expect(setTimeoutSpy).toHaveBeenCalled();
    });

    it('should reset deleteExpiredLogsRunning flag after execution', async () => {
      poolQuerySpy
        .mockImplementationOnce((query, values, cb) => cb(null, { affectedRows: 0 }));

      await errsoleMySQL.deleteExpiredLogs();

      expect(errsoleMySQL.deleteExpiredLogsRunning).toBe(false);
    });
  });
});
