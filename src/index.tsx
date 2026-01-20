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
 * ## Exports
 * - `EntityForm` - Form wrapper with overlay and transaction handling
 * - `Field` - Auto-rendering field with dirty styling
 * - `Submit` - Submit button, disabled when no dirty fields
 * - `SaveError` - Displays save errors, auto-clears on edit
 * - `ViewOnly` - Renders children only in view mode (editable=false)
 * - `EditOnly` - Renders children only in edit mode (editable=true)
 * - `EditTrigger` - Pencil icon button to activate edit mode
 * - `useEditable` - Hook to access editable state from context
 *
 * ## Activation Modes (activateOn prop)
 * - `"field"` (default): clicking any field activates edit mode
 * - `"form"`: clicking anywhere in the form activates edit mode
 * - `"trigger"`: only via EditTrigger or external trigger
 *
 * ## Usage (Edit)
 * ```tsx
 * <EntityForm view={customerView} onSuccess={() => navigate('/customers')}>
 *   <Field name="name" label="Name" />
 *   <Field name="email" label="Email" type="email" />
 *   <SaveError />
 *   <Submit>Save</Submit>
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

interface UIComponents {
  Input: React.ForwardRefExoticComponent<React.InputHTMLAttributes<HTMLInputElement> & React.RefAttributes<HTMLInputElement>>
  Button: ComponentType<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }>
  Label: ComponentType<React.LabelHTMLAttributes<HTMLLabelElement>>
  Select: ComponentType<{ value: string; onValueChange: (v: string) => void; disabled?: boolean; children: ReactNode }>
  SelectTrigger: React.ForwardRefExoticComponent<{ id?: string; className?: string; children: ReactNode } & React.RefAttributes<HTMLButtonElement>>
  SelectContent: ComponentType<{ children: ReactNode }>
  SelectItem: ComponentType<{ value: string; children: ReactNode }>
  SelectValue: ComponentType<{ placeholder?: string }>
  PencilIcon: ComponentType<{ className?: string; style?: React.CSSProperties }>
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
const DefaultPencilIcon: UIComponents["PencilIcon"] = ({ className, style }) => (
  <svg className={className} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </svg>
)

let _uiComponents: UIComponents = {
  Input: DefaultInput,
  Button: DefaultButton,
  Label: DefaultLabel,
  Select: DefaultSelect,
  SelectTrigger: DefaultSelectTrigger,
  SelectContent: DefaultSelectContent,
  SelectItem: DefaultSelectItem,
  SelectValue: DefaultSelectValue,
  PencilIcon: DefaultPencilIcon,
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

/** Controls how edit mode is activated */
type ActivateOn = "field" | "form" | "trigger"

interface EntityFormContextValue {
  view: EditableView | null
  mode: "create" | "edit"
  editable: boolean
  activateOn: ActivateOn
  overlay: Record<string, any>
  setOverlayValue: (name: string, value: any) => void
  hasDirtyFields: boolean
  saveError: string | null
  clearSaveError: () => void
  isSubmitting: boolean
  onActivate?: () => void
  onDeactivate?: () => void
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
  /** Whether the form is editable (default: true) */
  editable?: boolean
  /**
   * How edit mode is activated:
   * - "field" (default): clicking any field activates edit mode
   * - "form": clicking anywhere in the form activates edit mode
   * - "trigger": only via external trigger (e.g., EditTrigger component or ref)
   */
  activateOn?: ActivateOn
  /** Called when user clicks to activate edit mode */
  onActivate?: () => void
  /** Called when focus leaves the form and there are no dirty fields */
  onDeactivate?: () => void
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
  editable = true,
  activateOn = "field",
  onActivate,
  onDeactivate,
  children,
  onCreate,
  onSuccess,
  onError,
  className,
}: EntityFormProps) {
  // Track internally created view (for create-then-edit flow)
  const [createdView, setCreatedView] = useState<EditableView | null>(null)
  const view = viewProp ?? createdView

  const mode = view ? "edit" : "create"

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

  // Clear overlay when exiting edit mode (editable changes from true to false)
  useEffect(() => {
    if (!editable) {
      setOverlay({})
      setSaveError(null)
    }
  }, [editable])

  // Subscribe to view changes: clean overlay and force re-render
  // Note: The JS view wrapper reference may change across renders (ankurah#194), but all
  // references point to the same Arc'd Rust object underneath. So the `view` captured in
  // this closure is valid for reading current field values - no ref pattern needed.
  useEffect(() => {
    if (!view) return

    console.log("[EntityForm] Setting up subscribe for entity:", entityId)

    // subscribe() returns a SubscriptionGuard (RAII pattern), not a function
    const guard = view.subscribe(() => {
      console.log("[EntityForm] Subscribe callback fired! View values:", {
        name: view.name,
        email: view.email,
      })

      // Clean overlay entries where view now matches overlay value
      setOverlay((prev) => {
        const next = { ...prev }
        let changed = false
        for (const key of Object.keys(prev)) {
          if (view[key] === prev[key]) {
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
      console.log("[EntityForm] Cleaning up subscribe for entity:", entityId)
      guard.free()
    }
  }, [entityId])

  // Set a value in the overlay
  // If value matches view, remove from overlay (no longer dirty)
  const setOverlayValue = useCallback((name: string, value: any) => {
    setOverlay((prev) => {
      if (value === view?.[name]) {
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
  }, [view])

  // Check if any fields are dirty
  const hasDirtyFields = useMemo(() => {
    if (mode === "create") {
      // In create mode, dirty if any values in overlay
      return Object.keys(overlay).some((k) => overlay[k] !== "")
    }
    return Object.keys(overlay).some((k) => overlay[k] !== view?.[k])
  }, [overlay, view, mode])

  // Handle form submit
  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setIsSubmitting(true)
      setSaveError(null)

      try {
        const trx = getDeps().getContext().begin()

        if (mode === "edit" && view) {
          // Edit: apply only dirty fields
          const mutable = view.edit(trx)

          for (const [name, value] of Object.entries(overlay)) {
            if (value === view[name]) continue // Skip if not actually dirty

            const field = mutable[name]
            if (!field) continue

            // Normalize empty strings to null
            const normalizedValue = value === "" ? null : value

            // Detect field type and apply
            if (typeof field.replace === "function") {
              field.replace(normalizedValue ?? "")
            } else if (typeof field.set === "function") {
              field.set(normalizedValue)
            } else {
              console.warn(`EntityForm: Unknown field type for "${name}", skipping`)
            }
          }

          await trx.commit()
          setOverlay({})
          onSuccess?.()
        } else if (mode === "create" && model) {
          // Create: use overlay as the entity data
          const createData: Record<string, any> = {
            ...(defaultValuesProp ?? {}),
          }

          for (const [key, value] of Object.entries(overlay)) {
            createData[key] = value === "" ? null : value
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
    [mode, view, model, overlay, defaultValuesProp, onCreate, onSuccess, onError]
  )

  const contextValue = useMemo<EntityFormContextValue>(
    () => ({
      view,
      mode,
      editable,
      activateOn,
      overlay,
      setOverlayValue,
      hasDirtyFields,
      saveError,
      clearSaveError,
      isSubmitting,
      onActivate,
      onDeactivate,
    }),
    [
      view,
      mode,
      editable,
      activateOn,
      overlay,
      setOverlayValue,
      hasDirtyFields,
      saveError,
      clearSaveError,
      isSubmitting,
      onActivate,
      onDeactivate,
    ]
  )

  // Handle blur: deactivate if focus leaves the form and no dirty fields
  const handleFormBlur = useCallback(
    (e: React.FocusEvent<HTMLFormElement>) => {
      // Check if focus is moving to another element within the form
      const relatedTarget = e.relatedTarget as Node | null
      if (relatedTarget && e.currentTarget.contains(relatedTarget)) {
        return // Focus staying within form
      }
      // Focus leaving form - deactivate if clean
      if (!hasDirtyFields && onDeactivate) {
        onDeactivate()
      }
    },
    [hasDirtyFields, onDeactivate]
  )

  // Handle form-level click for activateOn="form"
  const handleFormClick = useCallback(() => {
    if (activateOn === "form" && !editable && onActivate) {
      onActivate()
    }
  }, [activateOn, editable, onActivate])

  return (
    <EntityFormContext.Provider value={contextValue}>
      <form
        onSubmit={handleSubmit}
        onBlur={handleFormBlur}
        onClick={activateOn === "form" ? handleFormClick : undefined}
        className={cn(className, activateOn === "form" && !editable && "cursor-text")}
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
  label: string
  type?: FieldType
  placeholder?: string
  options?: SelectOption[]
  className?: string
  disabled?: boolean
  /** Icon to show in view mode (replaces label). When provided:
   * - View mode: [icon] value (inline)
   * - Edit mode: label + input (stacked)
   */
  icon?: ReactNode
}

export function Field({
  name,
  label,
  type = "text",
  placeholder,
  options,
  className,
  disabled,
  icon,
}: FieldProps) {
  const { view, overlay, setOverlayValue, editable, activateOn, onActivate } = useEntityFormContext()
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>(null)
  const UI = getUI()

  // Field is disabled if explicitly disabled OR if form is not editable
  const isDisabled = disabled || !editable

  // Handler to activate edit mode when clicking a non-editable field
  // Only active when activateOn="field"
  const handleActivate = useCallback(() => {
    if (activateOn === "field" && !editable && onActivate) {
      onActivate()
      // Focus this field after React re-renders with editable=true
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [activateOn, editable, onActivate])

  // Should this field show clickable cursor in view mode?
  const canActivate = activateOn === "field" && !editable && !disabled

  // Compute display value: overlay if edited, otherwise view
  const viewValue = view?.[name] ?? ""
  const value = name in overlay ? overlay[name] : viewValue

  // Dirty if field is in overlay and differs from view
  const dirty = name in overlay && overlay[name] !== viewValue

  const fieldClassName = cn("space-y-2", className)
  const dirtyInputClassName = dirty ? "border-amber-500 bg-amber-50/50" : ""
  const borderlessClassName = !editable ? "border-transparent shadow-none bg-transparent" : ""

  // Cursor style for view mode - indicates clickability
  const viewModeCursor = canActivate ? "cursor-text" : ""

  // View mode with icon: render [icon] value inline
  if (icon && !editable) {
    // For select fields, find the label for the current value
    let displayValue = value ?? ""
    if (type === "select" && options) {
      const option = options.find((opt) => opt.value === value)
      displayValue = option?.label ?? value ?? ""
    }

    return (
      <div
        className={cn("flex items-center gap-2 py-1", viewModeCursor, className)}
        onClick={handleActivate}
      >
        <span className="text-muted-foreground flex-shrink-0">{icon}</span>
        <span className={cn("text-sm", !displayValue && "text-muted-foreground")}>
          {displayValue || placeholder || "—"}
        </span>
      </div>
    )
  }

  // Checkbox
  if (type === "checkbox") {
    return (
      <div
        className={cn("flex items-center gap-2", viewModeCursor, className)}
        data-dirty={dirty || undefined}
        onClick={handleActivate}
      >
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="checkbox"
          id={name}
          checked={!!value}
          disabled={isDisabled}
          onChange={(e) => setOverlayValue(name, e.target.checked)}
          className={cn("h-4 w-4 rounded border-gray-300", dirty && "ring-2 ring-amber-500")}
        />
        <UI.Label htmlFor={name} className={cn(dirty && "text-amber-700")}>
          {label}
        </UI.Label>
      </div>
    )
  }

  // Select
  if (type === "select") {
    if (!options) {
      console.warn(`Field "${name}": type="select" requires options prop`)
    }
    return (
      <div className={cn(fieldClassName, viewModeCursor)} data-dirty={dirty || undefined} onClick={handleActivate}>
        <UI.Label htmlFor={name} className={cn(dirty && "text-amber-700")}>
          {label}
        </UI.Label>
        <UI.Select
          value={value ?? ""}
          onValueChange={(v) => setOverlayValue(name, v)}
          disabled={isDisabled}
        >
          <UI.SelectTrigger
            ref={inputRef as React.RefObject<HTMLButtonElement>}
            id={name}
            className={cn(dirtyInputClassName, borderlessClassName)}
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
      <div className={cn(fieldClassName, viewModeCursor)} data-dirty={dirty || undefined} onClick={handleActivate}>
        <UI.Label htmlFor={name} className={cn(dirty && "text-amber-700")}>
          {label}
        </UI.Label>
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          id={name}
          value={value ?? ""}
          placeholder={placeholder}
          disabled={isDisabled}
          onChange={(e) => setOverlayValue(name, e.target.value)}
          className={cn(
            "flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            dirtyInputClassName,
            borderlessClassName
          )}
        />
      </div>
    )
  }

  // Number
  if (type === "number") {
    return (
      <div className={cn(fieldClassName, viewModeCursor)} data-dirty={dirty || undefined} onClick={handleActivate}>
        <UI.Label htmlFor={name} className={cn(dirty && "text-amber-700")}>
          {label}
        </UI.Label>
        <UI.Input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          id={name}
          type="number"
          value={value ?? ""}
          placeholder={placeholder}
          disabled={isDisabled}
          onChange={(e) => {
            const numValue = e.target.value === "" ? null : Number(e.target.value)
            setOverlayValue(name, numValue)
          }}
          className={cn(dirtyInputClassName, borderlessClassName)}
        />
      </div>
    )
  }

  // Default: text, email, tel, url, password
  return (
    <div className={cn(fieldClassName, viewModeCursor)} data-dirty={dirty || undefined} onClick={handleActivate}>
      <UI.Label htmlFor={name} className={cn(dirty && "text-amber-700")}>
        {label}
      </UI.Label>
      <UI.Input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        id={name}
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={isDisabled}
        onChange={(e) => setOverlayValue(name, e.target.value)}
        className={cn(dirtyInputClassName, borderlessClassName)}
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
 * Hook to access the editable state from EntityForm context.
 * Returns { editable, mode } where editable is the current edit state.
 */
export function useEditable() {
  const ctx = useContext(EntityFormContext)
  if (!ctx) {
    throw new Error("useEditable must be used within EntityForm")
  }
  return { editable: ctx.editable, mode: ctx.mode }
}

interface ModeProps {
  children: ReactNode
}

/**
 * Renders children only when in view mode (editable=false).
 * Use for custom view-mode layouts like icons next to values.
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
  return ctx.editable ? null : <>{children}</>
}

/**
 * Renders children only when in edit mode (editable=true).
 * Use for edit-specific UI like labels above inputs.
 *
 * ```tsx
 * <EditOnly>
 *   <UI.Label>Name</UI.Label>
 *   <UI.Input value={name} onChange={...} />
 * </EditOnly>
 * ```
 */
export function EditOnly({ children }: ModeProps) {
  const ctx = useContext(EntityFormContext)
  if (!ctx) {
    throw new Error("EditOnly must be used within EntityForm")
  }
  return ctx.editable ? <>{children}</> : null
}

// =============================================================================
// EditTrigger - Pencil icon button to activate edit mode
// =============================================================================

interface EditTriggerProps {
  className?: string
  /** Size of the pencil icon (default: 4 = w-4 h-4) */
  size?: number
}

/**
 * Pencil icon button that activates edit mode when clicked.
 * Only visible in view mode (editable=false).
 * Use with activateOn="trigger" for explicit edit activation.
 *
 * ```tsx
 * <EntityForm activateOn="trigger" editable={isEditing} onActivate={() => setIsEditing(true)}>
 *   <div className="flex items-center justify-between">
 *     <h2>Customer Info</h2>
 *     <EditTrigger />
 *   </div>
 *   <Field name="name" label="Name" />
 * </EntityForm>
 * ```
 */
export function EditTrigger({ className, size = 4 }: EditTriggerProps) {
  const ctx = useContext(EntityFormContext)
  if (!ctx) {
    throw new Error("EditTrigger must be used within EntityForm")
  }

  const { editable, onActivate } = ctx
  const UI = getUI()

  // Only show in view mode
  if (editable) return null

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation() // Don't trigger form-level click
        onActivate?.()
      }}
      className={cn(
        "text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted",
        className
      )}
      aria-label="Edit"
    >
      <UI.PencilIcon className={`w-${size} h-${size}`} style={{ width: size * 4, height: size * 4 }} />
    </button>
  )
}
