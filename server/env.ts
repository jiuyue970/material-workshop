// 必须在其他模块之前导入：crypto.ts 等在模块加载时读取环境变量
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
