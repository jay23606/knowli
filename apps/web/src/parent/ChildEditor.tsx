"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { messages, type ChildDto, type ChildPatch } from "@learning/contracts";
import { childPatch, interestsError, type EditValues } from "./children-forms";
import { InterestsTagsInput, useInterestNotice } from "./InterestsTagsInput";
import { runOnce } from "./run-once";
import { callParent, errorMessage, parentClient } from "./api";
import { ParentIcon } from "./ParentIcon";
import PronunciationSettings from "./PronunciationSettings";
import { AVATARS, avatarEmoji } from "./avatars";
import type { EditorLeaveState } from "./useParentLeaveGuard";
import "./children-panel.css";

type LeaveReporter = (key: string, state: EditorLeaveState | null) => void;

/**
 * Sekcja ma kilka niezależnych formularzy (edycja profilu, progi wymowy,
 * nowe dziecko), a leave guard trzyma jeden stan — składamy go z części:
 * dowolna niezapisana zmiana lub trwający zapis zatrzymuje wyjście.
 */
function useCombinedLeaveState(register: (state: EditorLeaveState) => void): LeaveReporter {
  const parts = useRef(new Map<string, EditorLeaveState>());
  const report = useCallback<LeaveReporter>((key, state) => {
    if (state) parts.current.set(key, state);
    else parts.current.delete(key);
    let dirty = false;
    let busy = false;
    for (const part of parts.current.values()) {
      dirty ||= part.dirty;
      busy ||= part.busy;
    }
    register({ dirty, busy });
  }, [register]);
  useEffect(() => () => register({ dirty: false, busy: false }), [register]);
  return report;
}

const avatarOptions = (current: string) => [
  ...(AVATARS.some((option) => option.key === current) ? [] : [{ value: current, label: "🙂" }]),
  ...AVATARS.map((option) => ({ value: option.key, label: option.emoji })),
];

/** Edycja profilu w karcie dziecka. Zapis zachowuje historię nauki. */
function ChildEditForm({
  child,
  onSaved,
  onCancel,
  onStateChange,
}: {
  child: ChildDto;
  onSaved: () => void;
  onCancel: () => void;
  onStateChange: (state: EditorLeaveState | null) => void;
}) {
  const nameField = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const form = useForm<EditValues>({
    initialValues: {
      displayName: child.displayName,
      avatarKey: child.avatarKey,
      recordingMode: child.recordingMode,
      canRead: child.canRead,
      interests: child.interests,
    },
  });
  // komunikat po próbie dodania powtórzenia lub szóstego tematu (znika przy dalszym pisaniu)
  const [interestNotice, setInterestNotice] = useInterestNotice();
  const update = useMutation({
    mutationFn: (patch: ChildPatch) => callParent(() => parentClient.children.update({ childId: child.id, ...patch })),
  });

  const patch = childPatch(child, form.values);
  const changed = Object.keys(patch).length > 0;
  const busy = update.isPending;
  const interestsInvalid = interestsError(form.values.interests);
  const canSave = !busy && form.values.displayName.trim().length > 0 && changed && interestsInvalid === null;

  useEffect(() => {
    nameField.current?.focus();
  }, []);
  useEffect(() => {
    onStateChange({ dirty: changed, busy });
  }, [onStateChange, changed, busy]);
  useEffect(() => () => onStateChange(null), [onStateChange]);

  const submit = form.onSubmit(() => {
    // blokada synchroniczna: drugi submit (Enter, requestSubmit) w trakcie żądania nic nie wysyła
    if (lock.current || !canSave) return;
    lock.current = true;
    update.mutate(patch, {
      onSuccess: onSaved,
      onSettled: () => { lock.current = false; },
    });
  });

  return (
    <form id={`child-edit-form-${child.id}`} className="pp-children-edit" onSubmit={submit}>
      <Divider my="md" />
      <Stack gap="sm">
        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
          <TextInput
            ref={nameField}
            size="md"
            label={messages.children.displayName}
            data-testid="child-edit-name"
            maxLength={80}
            disabled={busy}
            {...form.getInputProps("displayName")}
          />
          <NativeSelect
            size="md"
            label={messages.children.avatar}
            data-testid="child-edit-avatar"
            disabled={busy}
            data={avatarOptions(child.avatarKey)}
            {...form.getInputProps("avatarKey")}
          />
        </SimpleGrid>
        <NativeSelect
          size="md"
          label={messages.children.recordingMode}
          data-testid="child-edit-recording-mode"
          disabled={busy}
          data={[
            { value: "hold", label: messages.children.recordingModeHold },
            { value: "toggle", label: messages.children.recordingModeToggle },
          ]}
          {...form.getInputProps("recordingMode")}
        />
        <Checkbox
          size="md"
          label={messages.children.canRead}
          data-testid="child-edit-can-read"
          disabled={busy}
          checked={!form.values.canRead}
          onChange={(event) => form.setFieldValue("canRead", !event.currentTarget.checked)}
        />
        <div>
          <InterestsTagsInput
            label={messages.children.interests}
            data-testid="child-edit-interests"
            disabled={busy}
            value={form.values.interests}
            onChange={(next) => form.setFieldValue("interests", next)}
            notice={interestNotice}
            onNoticeChange={setInterestNotice}
            description={(
              <>
                <Text component="span" size="sm" display="block" className="pp-children-muted">{messages.children.interestsHint}</Text>
                <Text component="span" size="sm" display="block" mt={4} className="pp-children-muted">{messages.children.interestsPrivacy}</Text>
              </>
            )}
          />
        </div>
        {update.isError && <Alert color="red" variant="light" role="alert">{errorMessage(update.error)}</Alert>}
        <Group gap="sm" grow>
          <Button type="button" variant="default" size="md" data-testid="child-edit-cancel" disabled={busy} onClick={onCancel}>
            {messages.children.cancel}
          </Button>
          <Button type="submit" size="md" data-testid="child-edit-save" disabled={!canSave}>
            {messages.children.save}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

interface AddValues {
  displayName: string;
  avatarKey: string;
  birthYear: number | string;
}

const EMPTY_CHILD: AddValues = { displayName: "", avatarKey: AVATARS[0]!.key, birthYear: "" };

function AddChildForm({
  onAdded,
  onStateChange,
}: {
  onAdded: () => Promise<unknown>;
  onStateChange: (state: EditorLeaveState | null) => void;
}) {
  const form = useForm<AddValues>({
    initialValues: EMPTY_CHILD,
    validate: {
      displayName: (value) => (value.trim().length === 0 ? messages.children.nameRequired : null),
      birthYear: (value) =>
        value === "" || (typeof value === "number" && Number.isInteger(value) && value >= 1900 && value <= 2200)
          ? null
          : messages.children.birthYearInvalid,
    },
  });
  const [refreshFailed, setRefreshFailed] = useState(false);
  const mounted = useRef(true);
  // true także po ponownym montażu (Strict Mode: mount → cleanup → mount)
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const create = useMutation({
    mutationFn: (values: AddValues) => callParent(() => parentClient.children.create({
      displayName: values.displayName,
      avatarKey: values.avatarKey,
      ...(values.birthYear === "" ? {} : { birthYear: Number(values.birthYear) }),
    })),
    // wysłane dodanie nie blokuje wyjścia z sekcji: gdy rodzic już wyszedł,
    // błąd trafia do powiadomienia (formularz z komunikatem zniknął)
    onError: (cause, values) => {
      if (!mounted.current) {
        notifications.show({
          color: "red",
          title: messages.children.addFailedTitle.replace("{name}", values.displayName),
          message: errorMessage(cause),
        });
      }
    },
    // dziecko jest już zapisane: nieudane odświeżenie listy to osobny komunikat,
    // a nie błąd dodania (rodzic nie powinien dodawać go drugi raz)
    onSuccess: async () => {
      form.reset();
      try {
        await onAdded();
      } catch {
        // rodzic mógł już wyjść z sekcji — wtedy komunikat trafia do powiadomienia
        if (mounted.current) setRefreshFailed(true);
        else notifications.show({ color: "yellow", message: messages.children.addedRefreshFailed });
      }
    },
  });

  // Wysłane dodanie nie blokuje wyjścia z sekcji: kończy się samo (wywołania
  // zwrotne w opcjach hooka), a lista dzieci odświeża się niezależnie od
  // widoku. Chronimy tylko wpisane, jeszcze niewysłane dane.
  const dirty = !create.isPending
    && (form.values.displayName !== "" || form.values.birthYear !== "" || form.values.avatarKey !== EMPTY_CHILD.avatarKey);
  useEffect(() => {
    onStateChange({ dirty, busy: false });
  }, [onStateChange, dirty]);
  useEffect(() => () => onStateChange(null), [onStateChange]);

  return (
    <Paper component="form" radius="lg" p="md" className="pp-children-add" noValidate
      onSubmit={form.onSubmit((values) => { setRefreshFailed(false); create.mutate(values); })}>
      <Group gap="xs" mb="xs" className="pp-children-muted">
        <ParentIcon name="plus" />
        <Text fw={600}>{messages.children.add}</Text>
      </Group>
      <Stack gap="sm">
        <SimpleGrid cols={2} spacing="sm">
          <TextInput size="md" label={messages.children.displayName} data-testid="child-name" maxLength={80}
            disabled={create.isPending} {...form.getInputProps("displayName")} />
          <NativeSelect size="md" label={messages.children.avatar} data-testid="child-avatar"
            disabled={create.isPending} data={avatarOptions(AVATARS[0]!.key)} {...form.getInputProps("avatarKey")} />
        </SimpleGrid>
        <NumberInput size="md" label={messages.children.birthYear} data-testid="child-year" min={1900} max={2200}
          allowDecimal={false} allowNegative={false} clampBehavior="none" hideControls disabled={create.isPending}
          {...form.getInputProps("birthYear")} />
        {create.isError && (
          <Alert color="red" variant="light" role="alert" data-testid="api-error">{errorMessage(create.error)}</Alert>
        )}
        {refreshFailed && <Text size="sm" role="status">{messages.children.addedRefreshFailed}</Text>}
        <Button type="submit" size="md" variant="light" data-testid="child-add"
          disabled={create.isPending || form.values.displayName.length === 0}>
          {messages.children.add}
        </Button>
      </Stack>
    </Paper>
  );
}

/** Edycja zachowuje historię; tylko usunięcie profilu kasuje dane nauki. */
export default function ChildEditor({
  childrenList,
  onChanged,
  registerEditorState,
}: {
  childrenList: ChildDto[];
  onChanged: () => Promise<unknown>;
  registerEditorState: (state: EditorLeaveState) => void;
}) {
  const reportLeaveState = useCombinedLeaveState(registerEditorState);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [openSettings, setOpenSettings] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const heading = useRef<HTMLHeadingElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocus = useRef<string | null>(null);

  const reportEdit = useCallback((state: EditorLeaveState | null) => {
    setEditBusy(state?.busy ?? false);
    reportLeaveState("edit", state);
  }, [reportLeaveState]);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const reportSettings = useCallback((state: EditorLeaveState | null) => {
    setSettingsBusy(state?.busy ?? false);
    reportLeaveState("settings", state);
  }, [reportLeaveState]);
  const reportAdd = useCallback((state: EditorLeaveState | null) => reportLeaveState("add", state), [reportLeaveState]);

  // profil usunięty gdzie indziej znika razem z formularzem edycji
  const editing = childrenList.find((child) => child.id === editingId) ?? null;
  useEffect(() => {
    if (editingId !== null && editing === null) setEditingId(null);
  }, [editingId, editing]);

  // przycisk „Edytuj” jest wyłączony do końca zapisu — fokus wraca dopiero po odblokowaniu
  useEffect(() => {
    if (editingId === null && !editBusy && restoreFocus.current) {
      editButtons.current.get(restoreFocus.current)?.focus();
      restoreFocus.current = null;
    }
  }, [editingId, editBusy]);

  const startEdit = (child: ChildDto) => {
    if (editBusy) return;
    setStatus(null);
    setEditingId(child.id);
  };

  const closeEdit = () => {
    restoreFocus.current = editingId;
    setEditingId(null);
  };

  const afterSave = async () => {
    closeEdit();
    setStatus(messages.children.saved);
    try {
      await onChanged();
    } catch {
      setStatus(messages.children.savedRefreshFailed);
    }
  };

  // wywołania zwrotne w opcjach hooka (nie w `mutate`) działają dla każdego
  // usunięcia, także równoległych i po opuszczeniu sekcji — lista dzieci w
  // ParentApp zawsze się odświeży
  const remove = useMutation({
    mutationFn: (childId: string) => callParent(() => parentClient.children.remove({ childId })),
    onSuccess: async () => {
      try {
        await onChanged();
      } catch {
        setRemoveError(messages.children.removedRefreshFailed);
      }
    },
    onError: (cause) => setRemoveError(errorMessage(cause)),
    onSettled: (_data, _error, childId) => {
      setRemoving((current) => {
        const next = new Set(current);
        next.delete(childId);
        return next;
      });
    },
  });
  // trwające usunięcie wstrzymuje wyjście z sekcji jak każdy zapis
  useEffect(() => {
    reportLeaveState("remove", removing.size > 0 ? { dirty: false, busy: true } : null);
  }, [reportLeaveState, removing]);
  useEffect(() => () => reportLeaveState("remove", null), [reportLeaveState]);

  const confirmRemove = (child: ChildDto) => {
    if ((editBusy && editingId === child.id) || removing.has(child.id)) return;
    setRemoveError(null);
    modals.openConfirmModal({
      title: messages.children.removeTitle.replace("{name}", child.displayName),
      centered: true,
      radius: "lg",
      children: (
        <Stack gap="xs">
          <Text size="sm">{messages.children.removeConfirm}</Text>
          <Text size="sm">{messages.children.removeKeepsLessonThemes}</Text>
          <Text size="sm">{messages.children.removeKeepsCostTotals}</Text>
        </Stack>
      ),
      labels: { confirm: messages.children.remove, cancel: messages.children.cancel },
      confirmProps: { color: "red", size: "md", "data-testid": "child-remove-confirm" } as Record<string, unknown>,
      cancelProps: { size: "md", variant: "default", "data-autofocus": true, "data-testid": "child-remove-cancel" } as Record<string, unknown>,
      attributes: { content: { "data-testid": "child-remove-dialog" } },
      // karta zaraz zniknie, a przycisk „Usuń” jest zajęty — fokus na nagłówek sekcji
      returnFocus: false,
      onConfirm: runOnce(() => {
        setRemoving((current) => new Set(current).add(child.id));
        heading.current?.focus();
        remove.mutate(child.id);
      }),
    });
  };

  const avatarCounts = new Map<string, number>();
  for (const child of childrenList) avatarCounts.set(child.avatarKey, (avatarCounts.get(child.avatarKey) ?? 0) + 1);

  return (
    <Stack gap="md">
      <Title ref={heading} tabIndex={-1} order={1} fz={26} className="pp-children-heading">{messages.children.title}</Title>
      {status && <Text role="status">{status}</Text>}
      {removeError && <Alert color="red" variant="light" role="alert" data-testid="children-error">{removeError}</Alert>}
      {childrenList.length === 0 && <Text className="pp-children-muted">{messages.children.empty}</Text>}
      <SimpleGrid component="ul" cols={{ base: 1, xs: 2, md: 3 }} spacing="md" className="pp-children-grid">
        {childrenList.map((child, index) => {
          const isEditing = editing?.id === child.id;
          return (
            <Paper component="li" withBorder radius="lg" p="md" key={child.id} data-testid={`child-row-${index}`} className="pp-children-card">
              <Stack gap={4} align="center" ta="center">
                <div className="pp-child-avatar" aria-hidden="true">{avatarEmoji(child.avatarKey)}</div>
                <Text fw={700} fz="lg" className="pp-children-name">{child.displayName}</Text>
                <Text size="sm" className="pp-children-muted">
                  {child.birthYear ? `ur. ${child.birthYear} · ` : ""}
                  {messages.children.recordingMode}:{" "}
                  {child.recordingMode === "hold" ? messages.children.recordingModeHold : messages.children.recordingModeToggle}
                </Text>
                {avatarCounts.get(child.avatarKey)! > 1 && (
                  <Text size="sm" className="pp-children-warning" data-testid={`duplicate-avatar-warning-${index}`}>
                    {messages.children.duplicateAvatarWarning}
                  </Text>
                )}
              </Stack>
              <Stack gap="xs" mt="md">
                <Button component="a" size="md" href={`/kids/${child.id}/learn`} data-testid="child-learn-link"
                  leftSection={<ParentIcon name="play" />}>
                  {messages.children.startLearning}
                </Button>
                <SimpleGrid cols={2} spacing="xs">
                  <Button
                    variant="default"
                    size="md"
                    data-testid="child-edit"
                    ref={(button) => { if (button) editButtons.current.set(child.id, button); else editButtons.current.delete(child.id); }}
                    aria-expanded={isEditing}
                    aria-controls={`child-edit-form-${child.id}`}
                    disabled={editBusy}
                    leftSection={<ParentIcon name="pencil" />}
                    onClick={() => (isEditing ? closeEdit() : startEdit(child))}
                  >
                    {messages.children.edit}
                  </Button>
                  <Button
                    variant="default"
                    size="md"
                    data-testid={`child-settings-${index}`}
                    aria-expanded={openSettings === child.id}
                    leftSection={<ParentIcon name="mic" />}
                    disabled={settingsBusy}
                    onClick={() => setOpenSettings(openSettings === child.id ? null : child.id)}
                  >
                    {messages.children.pronunciationOpen}
                  </Button>
                </SimpleGrid>
                <Button
                  variant="subtle"
                  size="md"
                  className="pp-children-remove"
                  disabled={(editBusy && isEditing) || removing.has(child.id)}
                  onClick={() => confirmRemove(child)}
                >
                  {removing.has(child.id) ? messages.children.removing : messages.children.remove}
                </Button>
              </Stack>
              {isEditing && (
                <ChildEditForm child={child} onSaved={() => void afterSave()} onCancel={closeEdit} onStateChange={reportEdit} />
              )}
              {openSettings === child.id && <PronunciationSettings childId={child.id} onStateChange={reportSettings} />}
            </Paper>
          );
        })}
        <li className="pp-children-add-cell">
          <AddChildForm onAdded={onChanged} onStateChange={reportAdd} />
        </li>
      </SimpleGrid>
    </Stack>
  );
}
