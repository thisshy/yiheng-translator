import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "./components";
import { t } from "./i18n";

interface ModelPickerProps {
  id: string;
  value: string;
  models: readonly string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  commitOnBlur?: boolean;
}

export function ModelPicker({
  id,
  value,
  models,
  onChange,
  disabled,
  placeholder,
  commitOnBlur = false,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = `${id}-choices`;
  const expanded = open && !disabled && models.length > 0;
  const label = t("common.chooseModel");

  useEffect(() => {
    if (!expanded) return;
    const selected = list.current?.querySelector<HTMLButtonElement>(
      'button[aria-current="true"]',
    );
    (selected ?? list.current?.querySelector("button"))?.focus();
  }, [expanded]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };

  return (
    <div
      class="ui-model-picker"
      data-choices={models.length > 0 || undefined}
      onFocusOut={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          close();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        if (!expanded) {
          if (event.target === trigger.current && !disabled) {
            event.preventDefault();
            setOpen(true);
          }
          return;
        }
        const buttons = Array.from(
          list.current?.querySelectorAll("button") ?? [],
        );
        const current = buttons.findIndex((button) => button === event.target);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next =
          current === -1
            ? step > 0
              ? 0
              : buttons.length - 1
            : (current + step + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
      }}
    >
      <input
        id={id}
        type="text"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => setOpen(false)}
        onInput={(event) => {
          if (!commitOnBlur) onChange(event.currentTarget.value);
        }}
        onChange={(event) => {
          if (commitOnBlur) onChange(event.currentTarget.value);
        }}
      />
      {models.length > 0 && (
        <button
          ref={trigger}
          type="button"
          class="ui-model-trigger ui-button"
          aria-label={label}
          title={label}
          aria-expanded={expanded}
          aria-controls={listId}
          disabled={disabled}
          onClick={() => setOpen(!expanded)}
        >
          <span aria-hidden="true">▾</span>
        </button>
      )}
      {expanded && (
        <ul ref={list} id={listId} class="ui-model-list" aria-label={label}>
          {models.map((model) => (
            <li key={model}>
              <Button
                variant="quiet"
                aria-current={model === value ? "true" : undefined}
                onClick={() => {
                  close();
                  onChange(model);
                }}
              >
                {model}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
