"use client";

/**
 * Automated Email Page — enquiry acknowledgement templates, living under
 * Enquiry Management.
 *
 * Content: ENQUIRY EMAIL TEMPLATES — the automatic acknowledgement email sent
 * when a public website enquiry is submitted, for each of the three enquiry
 * types (admission, affiliation, general).
 *
 * Data flow:
 *   1. GET    /api/admin/enquiry-email-templates — every template, the
 *      built-in defaults and the source ("stored" | "default")
 *   2. PUT    /api/admin/enquiry-email-templates — { type, subject, body }
 *   3. DELETE /api/admin/enquiry-email-templates?type=… — drop the override
 *      so the built-in default takes over again
 *
 * Security:
 * - Every call sends the admin JWT; the API re-checks authentication and
 *   validation SERVER-side (this page's checks are convenience only).
 * - The preview is rendered LOCALLY from the draft with fixed sample data —
 *   opening it never sends an email, and no recipient value is ever accepted
 *   anywhere in this feature.
 * - Delivery configuration (API key, sender) lives only in environment
 *   variables and is never fetched, displayed or edited here.
 *
 * Preview and server validation share lib/email/enquiry-ack (pure module),
 * so what the admin sees locally is exactly what the server would send.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Mail,
  Save,
  RotateCcw,
  Eye,
  Check,
  AlertTriangle,
  Info,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import Card, { CardHeader } from "@/components/ui/card";
import Button from "@/components/ui/button";
import Badge from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/modal";
import ErrorState from "@/components/error-state";
import { type EnquiryType } from "@/lib/enquiry-types";
import {
  ACK_BODY_MAX_LENGTH,
  ACK_SUBJECT_MAX_LENGTH,
  ENQUIRY_ACK_PLACEHOLDERS,
  ENQUIRY_ACK_SAMPLE_VALUES,
  formatAckPlaceholder,
  renderAcknowledgement,
} from "@/lib/email/enquiry-ack";
import styles from "./page.module.css";

/* ── Page data ────────────────────────────────────────────────────────── */

interface TemplateState {
  subject: string;
  body: string;
  source: "stored" | "default";
}

interface Draft {
  subject: string;
  body: string;
}

type Messages = Partial<
  Record<EnquiryType, { kind: "success" | "error"; text: string }>
>;

const TYPE_SECTIONS: Array<{
  type: EnquiryType;
  title: string;
  subtitle: string;
}> = [
  {
    type: "admission",
    title: "Admission Enquiry Acknowledgement",
    subtitle:
      "Sent automatically when someone submits an admission enquiry through the website.",
  },
  {
    type: "affiliation",
    title: "College Registration Acknowledgement",
    subtitle:
      "Sent automatically when a college registration / affiliation enquiry is submitted.",
  },
  {
    type: "general",
    title: "General Enquiry Acknowledgement",
    subtitle:
      "Sent automatically when a general enquiry is submitted through the Contact Us form.",
  },
];

/** Confirmation copy for the per-type "Restore Default" dialog. */
const RESET_DESCRIPTIONS: Record<EnquiryType, string> = {
  admission:
    "Discard the customised admission acknowledgement and restore the application default?",
  affiliation:
    "Discard the customised college registration acknowledgement and restore the application default?",
  general:
    "Discard the customised general enquiry acknowledgement and restore the application default?",
};

const EMPTY_MESSAGES: Messages = {};

export default function AutomatedEmailPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [templates, setTemplates] = useState<
    Record<EnquiryType, TemplateState> | null
  >(null);
  const [drafts, setDrafts] = useState<Record<EnquiryType, Draft> | null>(null);

  const [saving, setSaving] = useState<EnquiryType | null>(null);
  const [messages, setMessages] = useState<Messages>(EMPTY_MESSAGES);
  const [previewOpen, setPreviewOpen] = useState<
    Record<EnquiryType, boolean>
  >({ admission: false, affiliation: false, general: false });
  const [resetTarget, setResetTarget] = useState<EnquiryType | null>(null);
  const [resetLoading, setResetLoading] = useState(false);

  /* ── Load ─────────────────────────────────────────────────── */

  const load = useCallback(async () => {
    const token = getStoredToken();
    if (!token) {
      setLoadError("Your session has expired. Please log in again.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setLoadError("");

    try {
      const res = await fetch("/api/admin/enquiry-email-templates", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setLoadError(data.message || "Unable to load email templates.");
        return;
      }

      const loaded = {} as Record<EnquiryType, TemplateState>;
      const loadedDrafts = {} as Record<EnquiryType, Draft>;
      for (const section of TYPE_SECTIONS) {
        const tpl = data.data.templates[section.type];
        loaded[section.type] = {
          subject: tpl.subject,
          body: tpl.body,
          source: tpl.source,
        };
        loadedDrafts[section.type] = { subject: tpl.subject, body: tpl.body };
      }
      setTemplates(loaded);
      setDrafts(loadedDrafts);
      setMessages(EMPTY_MESSAGES);
    } catch {
      setLoadError("Unable to connect to the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  /* ── Save ─────────────────────────────────────────────────── */

  function updateDraft(type: EnquiryType, patch: Partial<Draft>) {
    setDrafts((current) =>
      current ? { ...current, [type]: { ...current[type], ...patch } } : current
    );
    setMessages((current) => ({ ...current, [type]: undefined }));
  }

  function isDirty(type: EnquiryType): boolean {
    if (!drafts || !templates) return false;
    return (
      drafts[type].subject !== templates[type].subject ||
      drafts[type].body !== templates[type].body
    );
  }

  async function saveTemplate(type: EnquiryType) {
    if (!drafts || saving) return;

    const draft = drafts[type];
    const token = getStoredToken();
    if (!token) {
      setMessages({
        [type]: { kind: "error", text: "Your session has expired. Please log in again." },
      });
      return;
    }

    // Convenience checks only — the server validates authoritatively.
    if (!draft.subject.trim() || !draft.body.trim()) {
      setMessages({
        [type]: { kind: "error", text: "Subject and email body are both required." },
      });
      return;
    }

    setSaving(type);
    setMessages((current) => ({ ...current, [type]: undefined }));

    try {
      const res = await fetch("/api/admin/enquiry-email-templates", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ type, subject: draft.subject, body: draft.body }),
      });
      const data = await res.json();

      if (!data.success) {
        setMessages({
          [type]: { kind: "error", text: data.message || "Unable to save the template." },
        });
        return;
      }

      setTemplates((current) =>
        current
          ? {
              ...current,
              [type]: {
                subject: data.data.subject,
                body: data.data.body,
                source: "stored",
              },
            }
          : current
      );
      setDrafts((current) =>
        current
          ? {
              ...current,
              [type]: {
                subject: data.data.subject,
                body: data.data.body,
              },
            }
          : current
      );
      setMessages({
        [type]: { kind: "success", text: "Template saved successfully." },
      });
    } catch {
      setMessages({
        [type]: { kind: "error", text: "Unable to save the template. Please try again." },
      });
    } finally {
      setSaving(null);
    }
  }

  /* ── Reset to default ─────────────────────────────────────── */

  async function resetTemplate() {
    const type = resetTarget;
    if (!type || resetLoading) return;

    const token = getStoredToken();
    if (!token) {
      setResetTarget(null);
      setMessages({
        [type]: { kind: "error", text: "Your session has expired. Please log in again." },
      });
      return;
    }

    setResetLoading(true);
    try {
      const res = await fetch(
        `/api/admin/enquiry-email-templates?type=${encodeURIComponent(type)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();

      if (!data.success) {
        setMessages({
          [type]: { kind: "error", text: data.message || "Unable to reset the template." },
        });
        return;
      }

      setTemplates((current) =>
        current
          ? {
              ...current,
              [type]: {
                subject: data.data.subject,
                body: data.data.body,
                source: "default",
              },
            }
          : current
      );
      setDrafts((current) =>
        current
          ? {
              ...current,
              [type]: { subject: data.data.subject, body: data.data.body },
            }
          : current
      );
      setMessages({
        [type]: { kind: "success", text: "Restored the application default template." },
      });
    } catch {
      setMessages({
        [type]: { kind: "error", text: "Unable to reset the template. Please try again." },
      });
    } finally {
      setResetLoading(false);
      setResetTarget(null);
    }
  }

  /* ── Render ───────────────────────────────────────────────── */

  return (
    <div className={styles.page}>
      {/* Feature explainer */}
      <Card className={styles.section}>
        <CardHeader
          title="Automated Email"
          subtitle="Acknowledgement emails sent automatically for new enquiries"
        />
        <div className={styles.intro}>
          <Info size={16} />
          <span>
            These settings control the <strong>automatic acknowledgement</strong>{" "}
            email sent when a website enquiry is submitted. The separate manual{" "}
            <strong>reply</strong> workflow under Enquiry Management is
            unaffected. Delivery credentials (API key, sender) are environment
            configuration and are never edited here.
          </span>
        </div>
      </Card>

      {loading ? (
        <Card className={styles.section}>
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <p>Loading email templates...</p>
          </div>
        </Card>
      ) : loadError ? (
        <Card className={styles.section}>
          <ErrorState
            title="Unable to load email templates"
            description={loadError}
            onRetry={load}
          />
        </Card>
      ) : templates && drafts ? (
        TYPE_SECTIONS.map((section) => {
          const type = section.type;
          const saved = templates[type];
          const draft = drafts[type];
          const message = messages[type];
          const dirty = isDirty(type);
          const rendered = renderAcknowledgement(
            type,
            { subject: draft.subject, body: draft.body },
            ENQUIRY_ACK_SAMPLE_VALUES[type]
          );

          return (
            <Card key={type} className={styles.section}>
              <CardHeader
                title={section.title}
                subtitle={section.subtitle}
              />
              <div className={styles.metaRow}>
                <Badge variant={saved.source === "stored" ? "success" : "neutral"}>
                  {saved.source === "stored"
                    ? "Customised template active"
                    : "Application default in use"}
                </Badge>
              </div>

              <form
                className={styles.form}
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveTemplate(type);
                }}
              >
                <div className={styles.formField}>
                  <label htmlFor={`${type}-subject`}>Subject *</label>
                  <input
                    id={`${type}-subject`}
                    type="text"
                    maxLength={ACK_SUBJECT_MAX_LENGTH}
                    value={draft.subject}
                    onChange={(e) =>
                      updateDraft(type, { subject: e.target.value })
                    }
                    placeholder="Email subject line"
                  />
                  <span className={styles.hint}>
                    {draft.subject.length}/{ACK_SUBJECT_MAX_LENGTH} characters ·
                    one line
                  </span>
                </div>

                <div className={styles.formField}>
                  <label htmlFor={`${type}-body`}>Email Body *</label>
                  <textarea
                    id={`${type}-body`}
                    className={styles.textarea}
                    rows={12}
                    maxLength={ACK_BODY_MAX_LENGTH}
                    value={draft.body}
                    onChange={(e) => updateDraft(type, { body: e.target.value })}
                    placeholder="Write the acknowledgement email body..."
                  />
                  <span className={styles.hint}>
                    {draft.body.length}/{ACK_BODY_MAX_LENGTH} characters
                  </span>
                </div>

                <div className={styles.placeholderBox}>
                  <span className={styles.placeholderTitle}>
                    Available variables
                  </span>
                  <div className={styles.chips}>
                    {ENQUIRY_ACK_PLACEHOLDERS[type].map((name) => (
                      <code key={name} className={styles.chip}>
                        {formatAckPlaceholder(name)}
                      </code>
                    ))}
                  </div>
                  <span className={styles.hint}>
                    Filled from the submitted enquiry when the email is sent.
                    Unknown variables are never executed.
                  </span>
                </div>

                {message && (
                  <p
                    className={
                      message.kind === "success"
                        ? styles.formSuccess
                        : styles.formError
                    }
                  >
                    {message.kind === "success" ? (
                      <Check size={14} />
                    ) : (
                      <AlertTriangle size={14} />
                    )}{" "}
                    {message.text}
                  </p>
                )}

                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setPreviewOpen((current) => ({
                        ...current,
                        [type]: !current[type],
                      }))
                    }
                  >
                    <Eye size={15} />{" "}
                    {previewOpen[type] ? "Hide Preview" : "Preview"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={saved.source === "default" || saving !== null}
                    onClick={() => setResetTarget(type)}
                  >
                    <RotateCcw size={15} /> Restore Default
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={saving === type}
                    disabled={!dirty || saving !== null}
                  >
                    <Save size={15} /> Save Template
                  </Button>
                </div>
              </form>

              {previewOpen[type] && (
                <div className={styles.preview}>
                  <div className={styles.previewLabel}>
                    <Mail size={13} /> Preview — sample data, no email is sent
                  </div>
                  <div className={styles.previewSubject}>
                    <strong>Subject:</strong> {rendered.subject}
                  </div>
                  <pre className={styles.previewBody}>{rendered.text}</pre>
                </div>
              )}
            </Card>
          );
        })
      ) : null}

      <ConfirmDialog
        open={!!resetTarget}
        onClose={() => {
          if (!resetLoading) setResetTarget(null);
        }}
        onConfirm={resetTemplate}
        title="Restore Default Template"
        description={
          resetTarget
            ? RESET_DESCRIPTIONS[resetTarget]
            : "Restore the application default template?"
        }
        confirmLabel="Restore Default"
        variant="danger"
        loading={resetLoading}
      />
    </div>
  );
}
