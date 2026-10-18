'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');

const DEFAULT_TTL_SECONDS = 60 * 60; // 保存したゲーム状態の TTL は 1 時間。

// LINE のユーザー ID をキーにゲーム状態を保存する DynamoDB ストア。
const createStore = ({ tableName, ttlSeconds = DEFAULT_TTL_SECONDS, client } = {}) => {
  const doc = client || DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  return {
    async get(userId) {
      const { Item } = await doc.send(new GetCommand({ TableName: tableName, Key: { userId } }));
      return Item ? Item.state : null;
    },
    async put(userId, state) {
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      await doc.send(new PutCommand({ TableName: tableName, Item: { userId, state, expiresAt } }));
    },
    async delete(userId) {
      await doc.send(new DeleteCommand({ TableName: tableName, Key: { userId } }));
    },
  };
};

module.exports = { createStore };
