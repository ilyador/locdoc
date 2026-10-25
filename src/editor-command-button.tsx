import { useRef, type ComponentProps } from "react";

// Editing commands retain the native selection instead of focusing a button.
// WebKit may omit the compatibility click after that cancelled pointer down,
// so pointer release owns activation; click remains for keyboard/assistive use.
export function EditorCommandButton({
  run,
  ...props
}: Omit<ComponentProps<"button">, "onClick"> & { run: () => void }) {
  const pressed = useRef<number | null>(null);
  return (
    <button
      type="button"
      {...props}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          event.isPrimary === false ||
          event.currentTarget.disabled
        )
          return;
        pressed.current = event.pointerId;
        event.preventDefault();
      }}
      onPointerCancel={() => {
        pressed.current = null;
      }}
      onPointerLeave={() => {
        pressed.current = null;
      }}
      onPointerUp={(event) => {
        if (pressed.current !== event.pointerId) return;
        pressed.current = null;
        if (event.currentTarget.disabled) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        )
          run();
      }}
      onClick={(event) => {
        if (event.detail === 0 || !("PointerEvent" in window)) run();
      }}
    />
  );
}
