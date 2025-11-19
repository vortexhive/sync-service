'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('sync_errors', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      error_type: {
        type: Sequelize.STRING(100),
        allowNull: false,
        comment: 'Type of error (e.g., SYNC_USER_FAILED, UPSERT_USER_FAILED)'
      },
      user_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'User ID associated with the error'
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: false,
        comment: 'Error message'
      },
      error_stack: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Error stack trace'
      },
      additional_data: {
        type: Sequelize.JSONB,
        allowNull: true,
        comment: 'Additional error context data'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
        comment: 'Timestamp when error occurred'
      },
      resolved: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Whether the error has been resolved'
      },
      resolved_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Timestamp when error was resolved'
      },
      retry_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Number of retry attempts'
      }
    }, {
      comment: 'Stores sync errors for monitoring and troubleshooting'
    });

    // Create indexes for better query performance
    await queryInterface.addIndex('sync_errors', ['created_at'], {
      name: 'idx_sync_errors_created_at',
      using: 'BTREE'
    });

    await queryInterface.addIndex('sync_errors', ['error_type'], {
      name: 'idx_sync_errors_error_type',
      using: 'BTREE'
    });

    await queryInterface.addIndex('sync_errors', ['user_id'], {
      name: 'idx_sync_errors_user_id',
      using: 'BTREE',
      where: {
        user_id: {
          [Sequelize.Op.ne]: null
        }
      }
    });

    await queryInterface.addIndex('sync_errors', ['resolved'], {
      name: 'idx_sync_errors_resolved',
      using: 'BTREE'
    });

    console.log('✅ Created sync_errors table with indexes');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('sync_errors');
    console.log('✅ Dropped sync_errors table');
  }
};
