import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { cx } from "./cx.ts";
import "./TextField.css";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  /** `field` is bordered with 12px corners; `pill` is a borderless search or address bar. */
  variant?: "field" | "pill";
  invalid?: boolean;
  className?: string;
}

/** A single-line input: 44px tall, 16px text (smaller text makes iOS Safari zoom on focus). */
export function TextField({ variant = "field", invalid, className, ...props }: TextFieldProps) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      className={cx("ui-text-field", `ui-text-field--${variant}`, className)}
    />
  );
}

export type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & {
  className?: string;
};

/** A multi-line input that grows with its content, with no chrome of its own: put it in a card. */
export function TextArea({ className, ...props }: TextAreaProps) {
  return <textarea {...props} className={cx("ui-text-area", className)} />;
}

export interface FormFieldProps {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}

/** A caption above a control, with a hint or an error below it. */
export function FormField({ label, hint, error, children }: FormFieldProps) {
  return (
    <label className="ui-form-field">
      <span className="ui-form-field__label">{label}</span>
      {children}
      {error ? (
        <span className="ui-form-field__error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="ui-form-field__hint">{hint}</span>
      ) : null}
    </label>
  );
}
