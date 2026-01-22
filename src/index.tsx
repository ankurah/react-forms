/**
 * Ankurah Entity Forms
 *
 * DRY form components for creating and editing Ankurah entities.
 * Uses an overlay model for staged edits with live view comparison.
 *
 * ## How It Works
 * - `overlay` starts empty - only contains fields the user has edited
 * - Display value = `overlay[field] ?? view[field]`
 * - Dirty = `field in overlay && overlay[field] !== view[field]`
 * - When view updates remotely, untouched fields show new values
 * - When view updates to match an overlay value, that overlay entry is removed
 * - On save, only dirty fields are applied to the view
 *
 * ## Embedded Structs (e.g., Address)
 * Field names support dot notation for embedded Property structs:
 * ```tsx
 * <Field name="address.street1" label="Street" />
 * <Field name="address.city" label="City" />
 * ```
 * On save, fields are grouped by root and merged with existing values:
 * - `address.street1` + `address.city` → `mutable.address.set({ ...existing, street1, city })`
 *
 * ## Exports
 * - `EntityForm` - Form wrapper with overlay and transaction handling
 * - `Field` - Auto-rendering field with dirty styling (uses data-editing attribute)
 * - `Submit` - Submit button, disabled when no dirty fields
 * - `Cancel` - Cancel button to discard changes and exit editing
 * - `SaveError` - Displays save errors, auto-clears on edit
 * - `ViewOnly` - Renders children only in view mode (editing=false)
 * - `EditOnly` - Renders children only in edit mode (editing=true)
 * - `EditTrigger` - Button to enter edit mode (only visible in view mode)
 * - `useEditing` - Hook to access editing state from context
 *
 * ## Edit Triggers (editTrigger prop) - Edit mode only
 * Controls how edit mode is entered when viewing an existing entity:
 * - `"field"` (default): clicking any field starts editing
 * - `"form"`: clicking anywhere in the form starts editing
 * - `null`: no implicit click triggering (only EditTrigger button works)
 *
 * Note: In create mode (no view), the form is always in editing mode since there's
 * nothing to "view" yet. The editTrigger prop only applies to edit mode.
 *
 * ## Usage (Edit)
 * ```tsx
 * <EntityForm view={customerView} onSuccess={() => navigate('/customers')}>
 *   <Field name="name" label="Name" />
 *   <Field name="email" label="Email" type="email" />
 *   <EditOnly>
 *     <SaveError />
 *     <Cancel />
 *     <Submit>Save</Submit>
 *   </EditOnly>
 * </EntityForm>
 * ```
 *
 * ## Usage (Create)
 * ```tsx
 * <EntityForm model={Customer} onCreate={(view) => navigate(`/customers/${view.id}`)}>
 *   <Field name="name" label="Name" />
 *   <Submit>Create</Submit>
 * </EntityForm>
 * ```
 *
 * ## Layout & Field Groups
 * Field components use React context, so nest any layout between EntityForm and Field:
 * ```tsx
 * <EntityForm view={customer}>
 *   <Card>
 *     <CardContent className="grid grid-cols-2 gap-4">
 *       <Field name="name" label="Name" />
 *       <Field name="email" label="Email" type="email" />
 *     </CardContent>
 *   </Card>
 *   <SaveError />
 *   <Submit>Save</Submit>
 * </EntityForm>
 * ```
 */
import React, {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useState,
  useEffect,
  useReducer,
  useRef,
  FormEvent,
  ReactNode,
  forwardRef,
  ComponentType,
} from "react"

// =============================================================================
// Utility
// =============================================================================

/** Simple classname merge utility */
function cn(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(" ")
}

// =============================================================================
// Nested Value Utilities (for embedded structs like Address)
// =============================================================================

/**
 * Get a nested value from an object using dot notation.
 * e.g., getNestedValue(obj, 'address.street1') → obj.address?.street1
 */
function getNestedValue(obj: any, path: string): any {
  if (!path.includes('.')) return obj?.[path]
  const parts = path.split('.')
  let current = obj
  for (const key of parts) {
    if (current == null) return undefined
    current = current[key]
  }
  return current
}

/**
 * Set a nested value in an object using dot notation.
 * Mutates the target object. Creates intermediate objects as needed.
 * e.g., setNestedValue(obj, 'address.street1', 'value')
 */
function setNestedValue(obj: any, path: string, value: any): void {
  const parts = path.split('.')
  const last = parts.pop()!
  let current = obj
  for (const part of parts) {
    current[part] = current[part] ?? {}
    current = current[part]
  }
  current[last] = value
}

/**
 * Group flat dot-notation keys into nested objects.
 * e.g., { 'address.street1': 'x', 'address.city': 'y', 'name': 'z' }
 *    → { address: { street1: 'x', city: 'y' }, name: 'z' }
 */
function groupByRoot(overlay: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(overlay)) {
    if (!key.includes('.')) {
      result[key] = value
    } else {
      const [root, ...rest] = key.split('.')
      result[root] = result[root] ?? {}
      setNestedValue(result[root], rest.join('.'), value)
    }
  }
  return result
}

/**
 * Check if a root field name has any entries in the overlay.
 * Used to detect if an embedded struct has been modified.
 */
function hasOverlayEntriesForRoot(overlay: Record<string, any>, root: string): boolean {
  return Object.keys(overlay).some(key => key === root || key.startsWith(root + '.'))
}

// =============================================================================
// Ankurah Dependencies (injected via factory)
// =============================================================================

interface AnkurahContext {
  begin(): Transaction
}

interface Transaction {
  commit(): Promise<void>
}

interface AnkurahDeps {
  /** Function to get the Ankurah context (e.g., `ctx` from wasm bindings) */
  getContext: () => AnkurahContext
}

let _deps: AnkurahDeps | null = null

function getDeps(): AnkurahDeps {
  if (!_deps) {
    throw new Error(
      "Ankurah forms not initialized. Call initAnkurahForms({ getContext: () => ctx() }) first."
    )
  }
  return _deps
}

/**
 * Initialize ankurah-react-forms with your Ankurah context.
 * Call this once at app startup.
 *
 * @example
 * import { ctx } from "your-wasm-bindings"
 * import { initAnkurahForms } from "@ankurah/react-forms"
 *
 * initAnkurahForms({ getContext: () => ctx() })
 */
export function initAnkurahForms(deps: AnkurahDeps): void {
  _deps = deps
}

// =============================================================================
// UI Component Slots (allow customization)
// =============================================================================

// UI component types - intentionally permissive to work with various UI libraries
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface UIComponents {
  Input: ComponentType<any>
  Button: ComponentType<any>
  Label: ComponentType<any>
  Select: ComponentType<any>
  SelectTrigger: ComponentType<any>
  SelectContent: ComponentType<any>
  SelectItem: ComponentType<any>
  SelectValue: ComponentType<any>
}

// Default implementations using basic HTML
const DefaultInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  (props, ref) => <input ref={ref} {...props} />
)
DefaultInput.displayName = "DefaultInput"

const DefaultButton: UIComponents["Button"] = ({ variant, ...props }) => <button {...props} />
const DefaultLabel: UIComponents["Label"] = (props) => <label {...props} />

// Default select - basic HTML (consumers should override with their UI library)
const DefaultSelect: UIComponents["Select"] = ({ value, onValueChange, disabled, children }) => (
  <div>{children}</div>
)
const DefaultSelectTrigger = forwardRef<HTMLButtonElement, { id?: string; className?: string; children: ReactNode }>(
  ({ children, ...props }, ref) => <button ref={ref} type="button" {...props}>{children}</button>
)
DefaultSelectTrigger.displayName = "DefaultSelectTrigger"
const DefaultSelectContent: UIComponents["SelectContent"] = ({ children }) => <div>{children}</div>
const DefaultSelectItem: UIComponents["SelectItem"] = ({ value, children }) => <option value={value}>{children}</option>
const DefaultSelectValue: UIComponents["SelectValue"] = ({ placeholder }) => <span>{placeholder}</span>

let _uiComponents: UIComponents = {
  Input: DefaultInput,
  Button: DefaultButton,
  Label: DefaultLabel,
  Select: DefaultSelect,
  SelectTrigger: DefaultSelectTrigger,
  SelectContent: DefaultSelectContent,
  SelectItem: DefaultSelectItem,
  SelectValue: DefaultSelectValue,
}

/**
 * Configure UI components (e.g., from shadcn/ui).
 * Call this once at app startup.
 *
 * @example
 * import { Input } from "@/components/ui/input"
 * import { Button } from "@/components/ui/button"
 * // ...
 *
 * setUIComponents({ Input, Button, Label, Select, ... })
 */
export function setUIComponents(components: Partial<UIComponents>): void {
  _uiComponents = { ..._uiComponents, ...components }
}

function getUI(): UIComponents {
  return _uiComponents
}

// =============================================================================
// Types
// =============================================================================

/** RAII guard for a subscription - call free() to unsubscribe */
export interface SubscriptionGuard {
  free(): void
  [Symbol.dispose](): void
}

/** Any object with a to_base64() method for ID comparison */
export interface EntityId {
  to_base64(): string
}

export interface EditableView {
  id: EntityId
  edit(trx: Transaction): any
  subscribe(callback: () => void): SubscriptionGuard
  [key: string]: any
}

interface ModelClass {
  create(trx: any, values: Record<string, any>): Promise<EditableView>
}

interface SelectOption {
  value: string
  label: string
}

/**
 * Form mode controlling read/write capabilities:
 * - "r": Read-only (view only, no editing)
 * - "rw": Read-write (view first, can enter edit mode) - default for edit
 * - "w": Write-only (always editing, no view state) - default for create
 */
type FormMode = "r" | "rw" | "w"

/**
 * Controls how edit mode is entered (only applies when mode="rw"):
 * - "field": clicking any field starts editing (default)
 * - "form": clicking anywhere in the form starts editing
 * - null: no implicit click triggering (only EditTrigger button works)
 */
type EditTrigger = "field" | "form" | null

interface EntityFormContextValue {
  view: EditableView | null
  /** Whether this is a new entity (create) or existing (edit) */
  isNew: boolean
  /** Current editing state */
  editing: boolean
  /** How edit mode is triggered (only relevant for mode="rw") */
  editTrigger: EditTrigger
  /** Form mode: r (read-only), rw (read-write), w (write-only) */
  formMode: FormMode
  overlay: Record<string, any>
  setOverlayValue: (name: string, value: any) => void
  hasDirtyFields: boolean
  saveError: string | null
  clearSaveError: () => void
  isSubmitting: boolean
  /** Enter edit mode (only works in mode="rw") */
  startEditing: () => void
  /** Exit edit mode, discarding uncommitted changes */
  stopEditing: () => void
}

type FieldType =
  | "text"
  | "email"
  | "tel"
  | "url"
  | "password"
  | "number"
  | "textarea"
  | "checkbox"
  | "select"

// =============================================================================
// Context
// =============================================================================

const EntityFormContext = createContext<EntityFormContextValue | null>(null)

function useEntityFormContext() {
  const ctx = useContext(EntityFormContext)
  if (!ctx) {
    throw new Error("Field must be used within EntityForm")
  }
  return ctx
}

// =============================================================================
// EntityForm
// =============================================================================

interface EntityFormProps {
  /** Model class for create mode */
  model?: ModelClass
  /** Existing view for edit mode */
  view?: EditableView | null
  /** Default values for create mode */
  defaultValues?: Record<string, any>
  /**
   * Form mode: "r" (read-only), "rw" (read-write), "w" (write-only)
   * - Defaults to "w" for create (no view), "rw" for edit (has view)
   * - "r": View only, no editing allowed
   * - "rw": View first, can enter edit mode via editTrigger or EditTrigger button
   * - "w": Always editing, no view state
   */
  mode?: FormMode
  /**
   * How edit mode is entered (only applies when mode="rw"):
   * - "field" (default): clicking any field starts editing
   * - "form": clicking anywhere in the form starts editing
   * - null: no implicit click triggering (only EditTrigger button works)
   */
  editTrigger?: EditTrigger
  /** Called when entering edit mode */
  onStartEditing?: () => void
  /** Called when exiting edit mode */
  onStopEditing?: () => void
  children: ReactNode
  /** Called after successful create with the new view */
  onCreate?: (view: EditableView) => void
  /** Called after successful edit */
  onSuccess?: () => void
  /** Called on error */
  onError?: (error: unknown) => void
  className?: string
}

/**
 * EntityForm - uses view.subscribe() for reactivity
 */
export function EntityForm({
  model,
  view: viewProp,
  defaultValues: defaultValuesProp,
  mode: modeProp,
  editTrigger: editTriggerProp,
  onStartEditing,
  onStopEditing,
  children,
  onCreate,
  onSuccess,
  onError,
  className,
}: EntityFormProps) {
  // Track internally created view (for create-then-edit flow)
  const [createdView, setCreatedView] = useState<EditableView | null>(null)
  const view = viewProp ?? createdView

  // Is this a new entity (create) or existing (edit)?
  const isNew = !view

  // Resolve form mode: default to "w" for create, "rw" for edit
  const formMode: FormMode = modeProp ?? (isNew ? "w" : "rw")

  // Resolve edit trigger (only matters for mode="rw")
  const editTrigger: EditTrigger = editTriggerProp ?? "field"

  // Internal editing state for mode="rw"
  // - mode="r": always false (read-only)
  // - mode="w": always true (write-only)
  // - mode="rw": starts false, toggled by startEditing/stopEditing
  const [isEditing, setIsEditing] = useState(false)

  // Compute actual editing state based on mode
  const editing = formMode === "w" ? true : formMode === "r" ? false : isEditing

  // Track if we just transitioned from create to edit (for staying in edit mode)
  const wasCreating = useRef(isNew)
  useEffect(() => {
    if (wasCreating.current && !isNew) {
      // Just created - stay in edit mode
      setIsEditing(true)
    }
    wasCreating.current = isNew
  }, [isNew])

  // Start editing handler (only works in mode="rw")
  const startEditing = useCallback(() => {
    if (formMode === "rw" && !isEditing) {
      setIsEditing(true)
      onStartEditing?.()
    }
  }, [formMode, isEditing, onStartEditing])

  // Stop editing handler - clears overlay and exits edit mode
  const stopEditing = useCallback(() => {
    if (formMode === "rw" && isEditing) {
      setIsEditing(false)
      onStopEditing?.()
    }
  }, [formMode, isEditing, onStopEditing])

  // Validate props
  if (!view && !model) {
    throw new Error("EntityForm requires either 'view' (edit) or 'model' (create)")
  }

  const entityId = view?.id.to_base64() ?? null

  // Overlay: user's staged edits (initially empty)
  const [overlay, setOverlay] = useState<Record<string, any>>({})

  // Force re-render when view changes
  const [, forceRender] = useReducer((x) => x + 1, 0)

  // Error and submitting state
  const [saveError, setSaveError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const clearSaveError = useCallback(() => setSaveError(null), [])

  // Clear overlay when switching to a different entity
  useEffect(() => {
    setOverlay({})
    setSaveError(null)
  }, [entityId])

  // Clear overlay when exiting edit mode (editing changes from true to false)
  useEffect(() => {
    if (!editing) {
      setOverlay({})
      setSaveError(null)
    }
  }, [editing])

  // Subscribe to view changes: clean overlay and force re-render
  // Note: The JS view wrapper reference may change across renders (ankurah#194), but all
  // references point to the same Arc'd Rust object underneath. So the `view` captured in
  // this closure is valid for reading current field values - no ref pattern needed.
  useEffect(() => {
    if (!view) return

    // subscribe() returns a SubscriptionGuard (RAII pattern), not a function
    const guard = view.subscribe(() => {
      // Clean overlay entries where view now matches overlay value
      // Supports dot notation for embedded structs
      setOverlay((prev) => {
        const next = { ...prev }
        let changed = false
        for (const key of Object.keys(prev)) {
          if (getNestedValue(view, key) === prev[key]) {
            delete next[key]
            changed = true
          }
        }
        return changed ? next : prev
      })

      // Force re-render so Fields pick up new view values
      forceRender()
    })

    // Explicit cleanup (also handled by FinalizationRegistry, but being explicit)
    return () => {
      guard.free()
    }
  }, [entityId])

  // Set a value in the overlay
  // If value matches view, remove from overlay (no longer dirty)
  // Supports dot notation for embedded structs
  // Note: Uses entityId as dep instead of view for stability (ankurah views are "live" -
  // property getters read from underlying CRDT, so the captured view stays current)
  const setOverlayValue = useCallback((name: string, value: any) => {
    setOverlay((prev) => {
      if (value === getNestedValue(view, name)) {
        // Value matches view - remove from overlay if present
        if (!(name in prev)) return prev
        const next = { ...prev }
        delete next[name]
        return next
      }
      return { ...prev, [name]: value }
    })
    // Clear save error when user starts editing
    setSaveError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId])

  // Check if any fields are dirty
  // Note: Uses entityId instead of view for stability. View subscription triggers
  // forceRender which updates overlay, so hasDirtyFields recalculates correctly.
  const hasDirtyFields = useMemo(() => {
    if (isNew) {
      // In create mode, dirty if any values in overlay
      return Object.keys(overlay).some((k) => overlay[k] !== "")
    }
    // Support dot notation: compare overlay value to nested view value
    return Object.keys(overlay).some((k) => overlay[k] !== getNestedValue(view, k))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, entityId, isNew])

  // Handle form submit
  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setIsSubmitting(true)
      setSaveError(null)

      try {
        const trx = getDeps().getContext().begin()

        if (!isNew && view) {
          // Edit: apply only dirty fields
          const mutable = view.edit(trx)

          // Group overlay by root field to handle embedded structs
          // e.g., { 'address.street1': 'x', 'address.city': 'y', 'name': 'z' }
          //    → { address: { street1: 'x', city: 'y' }, name: 'z' }
          const grouped = groupByRoot(overlay)

          for (const [rootName, value] of Object.entries(grouped)) {
            const viewValue = view[rootName]

            // Check if this is an embedded struct (value is object, not primitive)
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
              // Embedded struct: merge overlay changes with existing view values
              const existing = viewValue ?? {}
              const merged: Record<string, any> = { ...existing }

              // Apply overlay values, normalizing empty strings to null
              for (const [key, val] of Object.entries(value)) {
                merged[key] = val === "" ? null : val
              }

              const field = mutable[rootName]
              if (field && typeof field.set === "function") {
                field.set(merged)
              } else {
                console.warn(`EntityForm: Cannot set embedded struct "${rootName}"`)
              }
            } else {
              // Primitive field: existing logic
              if (value === viewValue) continue // Skip if not actually dirty

              const field = mutable[rootName]
              if (!field) continue

              // Normalize empty strings to null
              const normalizedValue = value === "" ? null : value

              // Detect field type and apply
              if (typeof field.replace === "function") {
                field.replace(normalizedValue ?? "")
              } else if (typeof field.set === "function") {
                field.set(normalizedValue)
              } else {
                console.warn(`EntityForm: Unknown field type for "${rootName}", skipping`)
              }
            }
          }

          await trx.commit()
          setOverlay({})
          stopEditing()
          onSuccess?.()
        } else if (isNew && model) {
          // Create: use overlay as the entity data
          // Group by root to handle embedded structs (e.g., address.street1 → address: { street1 })
          const grouped = groupByRoot(overlay)

          const createData: Record<string, any> = {
            ...(defaultValuesProp ?? {}),
          }

          for (const [key, value] of Object.entries(grouped)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
              // Embedded struct: normalize empty strings to null within the object
              const normalized: Record<string, any> = {}
              for (const [k, v] of Object.entries(value)) {
                normalized[k] = v === "" ? null : v
              }
              createData[key] = normalized
            } else {
              createData[key] = value === "" ? null : value
            }
          }

          const newView = await model.create(trx, createData)
          await trx.commit()
          setCreatedView(newView)
          setOverlay({})
          onCreate?.(newView)
        }
      } catch (error) {
        console.error("EntityForm: Save failed:", error)
        const message = error instanceof Error ? error.message : "Save failed"
        setSaveError(message)
        onError?.(error)
      } finally {
        setIsSubmitting(false)
      }
    },
    // Note: Uses entityId instead of view for stability (view is still accessed via closure)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isNew, entityId, model, overlay, defaultValuesProp, stopEditing, onCreate, onSuccess, onError]
  )

  const contextValue = useMemo<EntityFormContextValue>(
    () => ({
      view,
      isNew,
      editing,
      editTrigger,
      formMode,
      overlay,
      setOverlayValue,
      hasDirtyFields,
      saveError,
      clearSaveError,
      isSubmitting,
      startEditing,
      stopEditing,
    }),
    [
      view,
      isNew,
      editing,
      editTrigger,
      formMode,
      overlay,
      setOverlayValue,
      hasDirtyFields,
      saveError,
      clearSaveError,
      isSubmitting,
      startEditing,
      stopEditing,
    ]
  )

  // Handle blur: exit edit mode if focus leaves the form and no dirty fields
  const handleFormBlur = useCallback(
    (e: React.FocusEvent<HTMLFormElement>) => {
      if (formMode !== "rw") return // Only applies to rw mode
      // Check if focus is moving to another element within the form
      const relatedTarget = e.relatedTarget as Node | null
      if (relatedTarget && e.currentTarget.contains(relatedTarget)) {
        return // Focus staying within form
      }
      // Focus leaving form - exit edit mode if clean
      if (!hasDirtyFields) {
        stopEditing()
      }
    },
    [formMode, hasDirtyFields, stopEditing]
  )

  // Handle form-level click for editTrigger="form"
  const handleFormClick = useCallback(() => {
    if (formMode === "rw" && editTrigger === "form" && !editing) {
      startEditing()
    }
  }, [formMode, editTrigger, editing, startEditing])

  return (
    <EntityFormContext.Provider value={contextValue}>
      <form
        onSubmit={handleSubmit}
        onBlur={handleFormBlur}
        onClick={editTrigger === "form" ? handleFormClick : undefined}
        className={cn(className, editTrigger === "form" && !editing && "cursor-text")}
        data-form-mode={formMode}
        data-editing={editing || undefined}
      >
        {children}
      </form>
    </EntityFormContext.Provider>
  )
}

// =============================================================================
// Field
// =============================================================================

interface FieldProps {
  name: string
  /** Label shown above the field. Optional - if not provided, no label is rendered. */
  label?: string
  type?: FieldType
  placeholder?: string
  /** Text to show when in view mode and the value is empty */
  emptyText?: string
  options?: SelectOption[]
  className?: string
  disabled?: boolean
  /** Icon shown as prefix to the input/value. Displays consistently in both view and edit modes. */
  icon?: ReactNode
  /** Custom className for the label element */
  labelClassName?: string
}

export function Field({
  name,
  label,
  type = "text",
  placeholder,
  emptyText,
  options,
  className,
  disabled,
  icon,
  labelClassName,
}: FieldProps) {
  const { view, overlay, setOverlayValue, editing, editTrigger, formMode, startEditing } = useEntityFormContext()
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement>(null)
  const UI = getUI()

  // Field is disabled if explicitly disabled OR if form is not in editing mode
  const isDisabled = disabled || !editing

  // Should this field be clickable to start editing?
  // True when in view mode and either: editTrigger="field" (click this field) or editTrigger="form" (click anywhere)
  const canStartEditing = formMode === "rw" && (editTrigger === "field" || editTrigger === "form") && !editing && !disabled

  // Handler to start editing when clicking a non-editing field
  const handleStartEditing = useCallback(() => {
    if (!canStartEditing) return
    startEditing()
    // Focus this field after React re-renders with editing=true
    requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
  }, [canStartEditing, startEditing])

  // Compute display value: overlay if edited, otherwise view
  // Supports dot notation for embedded structs (e.g., "address.street1")
  const viewValue = getNestedValue(view, name) ?? ""
  const value = name in overlay ? overlay[name] : viewValue

  // Dirty if field is in overlay and differs from view
  const dirty = name in overlay && overlay[name] !== viewValue

  // Helper to render label (only if provided)
  const labelElement = label ? (
    <UI.Label htmlFor={name} className={labelClassName} data-dirty={dirty || undefined}>
      {label}
    </UI.Label>
  ) : null

  // Helper to render icon prefix (shows in both modes)
  const hasIcon = !!icon
  const iconElement = icon ? <span data-field-icon="">{icon}</span> : null

  // Style to override the "not-allowed" cursor on disabled inputs in view mode
  const viewModeInputStyle = canStartEditing ? { cursor: "inherit", pointerEvents: "none" } as const : undefined
  const showEmptyText = !editing && !!emptyText && (value === "" || value == null)

  if (showEmptyText && type !== "checkbox") {
    const emptyCursorClass = type === "select" ? "cursor-pointer" : "cursor-text"
    return (
      <div
        className={cn(className, canStartEditing && emptyCursorClass)}
        data-field=""
        data-field-type={type}
        data-dirty={dirty || undefined}
        data-editing={editing || undefined}
        data-can-edit={canStartEditing || undefined}
        data-has-icon={hasIcon || undefined}
        onClick={handleStartEditing}
      >
        {labelElement}
        {iconElement}
        <span data-field-empty="">{emptyText}</span>
      </div>
    )
  }

  // Checkbox
  if (type === "checkbox") {
    return (
      <div
        className={cn(className, canStartEditing && "cursor-pointer")}
        data-field=""
        data-field-type="checkbox"
        data-dirty={dirty || undefined}
        data-editing={editing || undefined}
        data-can-edit={canStartEditing || undefined}
        data-has-icon={hasIcon || undefined}
        onClick={handleStartEditing}
      >
        {iconElement}
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="checkbox"
          id={name}
          checked={!!value}
          disabled={isDisabled}
          style={viewModeInputStyle}
          onChange={(e) => setOverlayValue(name, e.target.checked)}
          data-dirty={dirty || undefined}
        />
        {labelElement}
      </div>
    )
  }

  // Select
  if (type === "select") {
    if (!options) {
      console.warn(`Field "${name}": type="select" requires options prop`)
    }
    if (UI.Select === DefaultSelect) {
      return (
        <div
          className={cn(className, canStartEditing && "cursor-pointer")}
          data-field=""
          data-field-type="select"
          data-dirty={dirty || undefined}
          data-editing={editing || undefined}
          data-can-edit={canStartEditing || undefined}
          data-has-icon={hasIcon || undefined}
          onClick={handleStartEditing}
        >
          {labelElement}
          {iconElement}
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            id={name}
            value={value ?? ""}
            disabled={isDisabled}
            style={viewModeInputStyle}
            onChange={(e) => setOverlayValue(name, e.target.value)}
            data-dirty={dirty || undefined}
            data-editing={editing || undefined}
          >
            {placeholder ? <option value="" disabled>{placeholder}</option> : null}
            {options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )
    }
    return (
      <div
        className={cn(className, canStartEditing && "cursor-pointer")}
        data-field=""
        data-field-type="select"
        data-dirty={dirty || undefined}
        data-editing={editing || undefined}
        data-can-edit={canStartEditing || undefined}
        data-has-icon={hasIcon || undefined}
        onClick={handleStartEditing}
      >
        {labelElement}
        {iconElement}
        <UI.Select
          value={value ?? ""}
          onValueChange={(v: string) => setOverlayValue(name, v)}
          disabled={isDisabled}
        >
          <UI.SelectTrigger
            ref={inputRef as React.RefObject<HTMLButtonElement>}
            id={name}
            data-dirty={dirty || undefined}
            data-editing={editing || undefined}
            style={viewModeInputStyle}
          >
            <UI.SelectValue placeholder={placeholder} />
          </UI.SelectTrigger>
          <UI.SelectContent>
            {options?.map((opt) => (
              <UI.SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </UI.SelectItem>
            ))}
          </UI.SelectContent>
        </UI.Select>
      </div>
    )
  }

  // Textarea
  if (type === "textarea") {
    return (
      <div
        className={cn(className, canStartEditing && "cursor-text")}
        data-field=""
        data-field-type="textarea"
        data-dirty={dirty || undefined}
        data-editing={editing || undefined}
        data-can-edit={canStartEditing || undefined}
        data-has-icon={hasIcon || undefined}
        onClick={handleStartEditing}
      >
        {labelElement}
        {iconElement}
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          id={name}
          value={value ?? ""}
          placeholder={placeholder}
          disabled={isDisabled}
          style={viewModeInputStyle}
          onChange={(e) => setOverlayValue(name, e.target.value)}
          data-dirty={dirty || undefined}
          data-editing={editing || undefined}
        />
      </div>
    )
  }

  // Number
  if (type === "number") {
    return (
      <div
        className={cn(className, canStartEditing && "cursor-text")}
        data-field=""
        data-field-type="number"
        data-dirty={dirty || undefined}
        data-editing={editing || undefined}
        data-can-edit={canStartEditing || undefined}
        data-has-icon={hasIcon || undefined}
        onClick={handleStartEditing}
      >
        {labelElement}
        {iconElement}
        <UI.Input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          id={name}
          type="number"
          value={value ?? ""}
          placeholder={placeholder}
          disabled={isDisabled}
          style={viewModeInputStyle}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const numValue = e.target.value === "" ? null : Number(e.target.value)
            setOverlayValue(name, numValue)
          }}
          data-dirty={dirty || undefined}
          data-editing={editing || undefined}
        />
      </div>
    )
  }

  // Default: text, email, tel, url, password
  return (
    <div
      className={cn(className, canStartEditing && "cursor-text")}
      data-field=""
      data-field-type={type}
      data-dirty={dirty || undefined}
      data-editing={editing || undefined}
      data-can-edit={canStartEditing || undefined}
      data-has-icon={hasIcon || undefined}
      onClick={handleStartEditing}
    >
      {labelElement}
      {iconElement}
      <UI.Input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        id={name}
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={isDisabled}
        style={viewModeInputStyle}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOverlayValue(name, e.target.value)}
        data-dirty={dirty || undefined}
        data-editing={editing || undefined}
      />
    </div>
  )
}

// =============================================================================
// Submit
// =============================================================================

interface SubmitProps {
  children: ReactNode
  className?: string
}

export function Submit({ children, className }: SubmitProps) {
  const { hasDirtyFields, isSubmitting } = useEntityFormContext()
  const UI = getUI()

  return (
    <UI.Button
      type="submit"
      disabled={!hasDirtyFields || isSubmitting}
      className={className}
    >
      {isSubmitting ? "Saving..." : children}
    </UI.Button>
  )
}

// =============================================================================
// Cancel
// =============================================================================

interface CancelProps {
  children?: ReactNode
  className?: string
}

/**
 * Button that discards changes and exits edit mode.
 * Only functional in mode="rw" - does nothing in "w" mode (create).
 *
 * ```tsx
 * <EditOnly>
 *   <Cancel>Discard</Cancel>
 *   <Submit>Save</Submit>
 * </EditOnly>
 * ```
 */
export function Cancel({ children = "Cancel", className }: CancelProps) {
  const { formMode, stopEditing, isSubmitting } = useEntityFormContext()
  const UI = getUI()

  // Cancel only makes sense in rw mode (view/edit toggle)
  // In "w" mode (create), there's no view state to return to
  if (formMode !== "rw") return null

  return (
    <UI.Button
      type="button"
      variant="outline"
      disabled={isSubmitting}
      onClick={stopEditing}
      className={className}
    >
      {children}
    </UI.Button>
  )
}

// =============================================================================
// SaveError
// =============================================================================

interface SaveErrorProps {
  className?: string
}

/**
 * Displays save errors from the EntityForm.
 * Position anywhere within the form. Errors auto-clear when user edits.
 */
export function SaveError({ className }: SaveErrorProps) {
  const { saveError, clearSaveError } = useEntityFormContext()

  if (!saveError) return null

  return (
    <div
      className={cn(
        "rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive",
        className
      )}
      role="alert"
    >
      <div className="flex items-start justify-between gap-2">
        <span>{saveError}</span>
        <button
          type="button"
          onClick={clearSaveError}
          className="text-destructive/70 hover:text-destructive -mt-0.5"
          aria-label="Dismiss error"
        >
          ×
        </button>
      </div>
    </div>
  )
}

// =============================================================================
// Mode-Switching Components
// =============================================================================

/**
 * Hook to access editing state from EntityForm context.
 * Returns { editing, isNew, formMode } for conditional rendering.
 */
export function useEditing() {
  const ctx = useContext(EntityFormContext)
  if (!ctx) {
    throw new Error("useEditing must be used within EntityForm")
  }
  return { editing: ctx.editing, isNew: ctx.isNew, formMode: ctx.formMode }
}

interface ModeProps {
  children: ReactNode
}

/**
 * Renders children only when NOT in editing mode.
 * Use for view-specific layouts like formatted displays.
 *
 * ```tsx
 * <ViewOnly>
 *   <div className="flex items-center gap-2">
 *     <UserIcon className="w-4 h-4" />
 *     <span>{customer.name}</span>
 *   </div>
 * </ViewOnly>
 * ```
 */
export function ViewOnly({ children }: ModeProps) {
  const ctx = useContext(EntityFormContext)
  if (!ctx) {
    throw new Error("ViewOnly must be used within EntityForm")
  }
  return ctx.editing ? null : <>{children}</>
}

/**
 * Renders children only when in editing mode.
 * Use for edit-specific UI like save/cancel buttons or additional fields.
 *
 * ```tsx
 * <EditOnly>
 *   <SaveError />
 *   <Cancel />
 *   <Submit>Save</Submit>
 * </EditOnly>
 * ```
 */
export function EditOnly({ children }: ModeProps) {
  const ctx = useContext(EntityFormContext)
  if (!ctx) {
    throw new Error("EditOnly must be used within EntityForm")
  }
  return ctx.editing ? <>{children}</> : null
}

// =============================================================================
// EditTrigger - Button to activate edit mode
// =============================================================================

interface EditTriggerProps {
  /** Icon or content to display (e.g., <Pencil className="w-4 h-4" />) */
  children: ReactNode
  className?: string
}

/**
 * Button that enters edit mode when clicked.
 * Only visible when not editing (and mode != "r").
 * Use with editTrigger={null} for explicit edit buttons.
 *
 * ```tsx
 * import { Pencil } from "lucide-react"
 *
 * <EntityForm view={customerView} editTrigger={null}>
 *   <div className="flex items-center justify-between">
 *     <h2>Customer Info</h2>
 *     <EditTrigger><Pencil className="w-4 h-4" /></EditTrigger>
 *   </div>
 *   <Field name="name" label="Name" />
 * </EntityForm>
 * ```
 */
export function EditTrigger({ children, className }: EditTriggerProps) {
  const ctx = useContext(EntityFormContext)
  if (!ctx) {
    throw new Error("EditTrigger must be used within EntityForm")
  }

  const { editing, formMode, startEditing } = ctx

  // Only show in view mode (not editing) and only if editing is possible (not mode="r")
  if (editing || formMode === "r") return null

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation() // Don't trigger form-level click
        startEditing()
      }}
      className={cn(
        "text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted",
        className
      )}
      aria-label="Edit"
    >
      {children}
    </button>
  )
}
