declare module "*.png" {
  const url: string;
  export default url;
}

declare module "*.png?inline" {
  const url: string;
  export default url;
}

declare module "*.lottie" {
  const url: string;
  export default url;
}

declare module "*.lottie?url" {
  const url: string;
  export default url;
}

declare module "*.wasm?url" {
  const url: string;
  export default url;
}
