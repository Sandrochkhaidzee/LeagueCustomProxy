/** Compile-time flag injected by webpack DefinePlugin (PROXCHAT_DEV_BUILD=1). */
declare const __DEV_BUILD__: boolean;

export const IS_DEV_BUILD: boolean =
  typeof __DEV_BUILD__ !== 'undefined' ? __DEV_BUILD__ : false;
