/**
 * 中性值处理工具的公开入口。
 *
 * 这里只放与业务无关的纯函数机械能力，供 `kernel`、`domain`、`adapters`、`app`
 * 各层复用。禁止在此引入任何 feature 类型、业务语义或副作用。
 */

export { asOptionalRecord, asRecord, isPlainRecord } from "./record.js";
export {
  booleanOrUndefined,
  isString,
  nonNegativeInteger,
  numberOrUndefined,
  positiveInteger,
  rawStringOrUndefined,
  stringOrUndefined,
} from "./scalar.js";
export {
  stringArray,
  stringArrayOrUndefined,
  uniqueNonBlankStrings,
  uniqueValues,
} from "./collection.js";
export {
  errorMessage,
  isFileNotFound,
  isNodeError,
  isTransientRenameError,
} from "./error.js";
export { cloneDeep, toPersistedJsonShape } from "./clone.js";
