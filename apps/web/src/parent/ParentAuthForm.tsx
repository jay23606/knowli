"use client";

import { useState, type ReactNode } from "react";
import { Alert, Button, Group, PasswordInput, Stack } from "@mantine/core";
import { messages } from "@learning/contracts";
import { errorMessage } from "./api";

/**
 * Formularz PIN/hasła rodzica — wspólny dla ekranu logowania, pierwszego
 * uruchomienia i ponownego logowania po wygaśnięciu sesji. `submit` rzuca
 * błąd z komunikatem dla rodzica; sekret jest czyszczony po sukcesie.
 */
export function ParentAuthForm({
  submitLabel,
  submit,
  idPrefix,
  extraAction,
  testIds,
  initialError = null,
  withSetupToken = false,
}: {
  submitLabel: string;
  submit: (secret: string, setupToken: string) => Promise<void>;
  idPrefix: string;
  extraAction?: ReactNode;
  testIds: { secret: string; submit: string; error: string };
  initialError?: string | null;
  /** Pierwsze uruchomienie: dodatkowe pole kodu konfiguracji (#307). */
  withSetupToken?: boolean;
}) {
  const [secret, setSecret] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        submit(secret, setupToken)
          .then(() => {
            setSecret("");
            setSetupToken("");
          })
          .catch((cause: unknown) => setError(errorMessage(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <Stack gap="md">
        <PasswordInput
          id={`${idPrefix}-secret`}
          label={messages.auth.pinLabel}
          size="md"
          autoComplete={withSetupToken ? "new-password" : "current-password"}
          required
          value={secret}
          onChange={(event) => setSecret(event.currentTarget.value)}
          data-testid={testIds.secret}
          data-autofocus
        />
        {withSetupToken && (
          <PasswordInput
            id={`${idPrefix}-setup-token`}
            label={messages.auth.setupTokenLabel}
            size="md"
            autoComplete="off"
            required
            value={setupToken}
            onChange={(event) => setSetupToken(event.currentTarget.value)}
            data-testid={`${testIds.secret}-setup-token`}
          />
        )}
        {error && (
          <Alert color="red" variant="light" role="alert" data-testid={testIds.error}>
            {error}
          </Alert>
        )}
        <Group gap="sm">
          <Button type="submit" size="md" loading={busy} data-testid={testIds.submit}>
            {submitLabel}
          </Button>
          {extraAction}
        </Group>
      </Stack>
    </form>
  );
}
