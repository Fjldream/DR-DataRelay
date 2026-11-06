import { LicenseManager as RequiredLicenseManager } from './manager.js';
import { NoLicenseManager } from './no-license-manager.js';

// 交付构建会将该常量替换为 true/false。本地源码运行默认启用授权。
const licenseRequired = typeof __LICENSE_REQUIRED__ === 'boolean' ? __LICENSE_REQUIRED__ : true;

export const LicenseManager = licenseRequired ? RequiredLicenseManager : NoLicenseManager;
