require('dotenv').config();

module.exports = {
  development: {
    username: process.env.CHAT_DB_USER || 'postgres',
    password: process.env.CHAT_DB_PASSWORD,
    database: process.env.CHAT_DB_NAME || 'myusta_chatapp',
    host: process.env.CHAT_DB_HOST || 'localhost',
    port: parseInt(process.env.CHAT_DB_PORT) || 5432,
    dialect: 'postgres',
    logging: console.log
  },
  production: {
    username: process.env.CHAT_DB_USER || 'postgres',
    password: process.env.CHAT_DB_PASSWORD,
    database: process.env.CHAT_DB_NAME || 'myusta_chatapp',
    host: process.env.CHAT_DB_HOST || 'localhost',
    port: parseInt(process.env.CHAT_DB_PORT) || 5432,
    dialect: 'postgres',
    logging: false,
    pool: {
      max: 10,
      min: 2,
      acquire: 30000,
      idle: 10000
    }
  }
};
