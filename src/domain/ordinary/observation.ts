/** Stable evidence identity carried by Ordinary model input and read models. */
export type ObservationRef = {
  readonly kind: "event" | "tool_call" | "model_call" | "goal" | "trace";
  readonly id: string;
  readonly label?: string;
  readonly version?: string | number;
};
