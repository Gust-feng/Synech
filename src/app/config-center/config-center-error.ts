export class ConfigCenterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigCenterValidationError";
  }
}
