# @ankurah/react-forms

DRY form components for creating and editing Ankurah entities with overlay-based staged edits.

## Installation

```bash
npm install @ankurah/react-forms
```

## Setup

Initialize the library with your Ankurah context at app startup:

```tsx
import { ctx } from "your-wasm-bindings"
import { initAnkurahForms, setUIComponents } from "@ankurah/react-forms"

// Required: Connect to Ankurah
initAnkurahForms({ getContext: () => ctx() })

// Optional: Use your UI library components (e.g., shadcn/ui)
import { Input, Button, Label, Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui"

setUIComponents({ Input, Button, Label, Select, SelectTrigger, SelectContent, SelectItem, SelectValue })
```

## How It Works

The library uses an **overlay model** for staged edits:

- `overlay` starts empty - only contains fields the user has edited
- Display value = `overlay[field] ?? view[field]`
- Dirty = field is in overlay and differs from view
- When the view updates remotely, untouched fields show new values
- When the view updates to match an overlay value, that overlay entry is removed
- On save, only dirty fields are applied to the view

## Usage

### Edit Mode

```tsx
import { EntityForm, Field, Submit, SaveError } from "@ankurah/react-forms"

function CustomerEditor({ customerView }) {
  return (
    <EntityForm view={customerView} onSuccess={() => navigate('/customers')}>
      <Field name="name" label="Name" />
      <Field name="email" label="Email" type="email" />
      <SaveError />
      <Submit>Save</Submit>
    </EntityForm>
  )
}
```

### Create Mode

```tsx
<EntityForm model={Customer} onCreate={(view) => navigate(`/customers/${view.id}`)}>
  <Field name="name" label="Name" />
  <Field name="email" label="Email" type="email" />
  <Submit>Create</Submit>
</EntityForm>
```

### With Custom Layout

Field components use React context, so nest any layout between EntityForm and Field:

```tsx
<EntityForm view={customer}>
  <Card>
    <CardContent className="grid grid-cols-2 gap-4">
      <Field name="name" label="Name" />
      <Field name="email" label="Email" type="email" />
    </CardContent>
  </Card>
  <SaveError />
  <Submit>Save</Submit>
</EntityForm>
```

### Activation Modes

Control how edit mode is activated with the `activateOn` prop:

```tsx
// "field" (default): clicking any field activates edit mode
<EntityForm view={customer} activateOn="field" editable={isEditing} onActivate={() => setIsEditing(true)}>

// "form": clicking anywhere in the form activates edit mode
<EntityForm view={customer} activateOn="form" editable={isEditing} onActivate={() => setIsEditing(true)}>

// "trigger": only via EditTrigger button or external trigger
<EntityForm view={customer} activateOn="trigger" editable={isEditing} onActivate={() => setIsEditing(true)}>
  <div className="flex items-center justify-between">
    <h2>Customer Info</h2>
    <EditTrigger><Pencil className="w-4 h-4" /></EditTrigger>
  </div>
  <Field name="name" label="Name" />
</EntityForm>
```

### Field Types

```tsx
<Field name="name" label="Name" type="text" />
<Field name="email" label="Email" type="email" />
<Field name="phone" label="Phone" type="tel" />
<Field name="website" label="Website" type="url" />
<Field name="password" label="Password" type="password" />
<Field name="age" label="Age" type="number" />
<Field name="bio" label="Bio" type="textarea" />
<Field name="active" label="Active" type="checkbox" />
<Field name="status" label="Status" type="select" options={[
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
]} />
```

### Icon Mode for View State

Fields can display with an icon in view mode and switch to a labeled input in edit mode:

```tsx
import { Mail, Phone } from "lucide-react"

<Field name="email" label="Email" type="email" icon={<Mail className="w-4 h-4" />} />
<Field name="phone" label="Phone" type="tel" icon={<Phone className="w-4 h-4" />} />
```

### Conditional Rendering

```tsx
<EntityForm view={customer} editable={isEditing}>
  <ViewOnly>
    {/* Only shown when not editing */}
    <div className="text-lg font-bold">{customer.name}</div>
  </ViewOnly>
  <EditOnly>
    {/* Only shown when editing */}
    <Field name="name" label="Name" />
  </EditOnly>
</EntityForm>
```

### Using the Edit State Hook

```tsx
function CustomComponent() {
  const { editable, mode } = useEditable()

  return (
    <div>
      {mode === "create" ? "Creating new" : "Editing"}
      {editable ? " (active)" : " (viewing)"}
    </div>
  )
}
```

## API Reference

### Components

| Component | Description |
|-----------|-------------|
| `EntityForm` | Form wrapper with overlay and transaction handling |
| `Field` | Auto-rendering field with dirty styling |
| `Submit` | Submit button, disabled when no dirty fields |
| `SaveError` | Displays save errors, auto-clears on edit |
| `ViewOnly` | Renders children only in view mode |
| `EditOnly` | Renders children only in edit mode |
| `EditTrigger` | Button to activate edit mode |

### Functions

| Function | Description |
|----------|-------------|
| `initAnkurahForms(deps)` | Initialize with Ankurah context |
| `setUIComponents(components)` | Configure UI components |
| `useEditable()` | Hook to access edit state from context |

### EntityForm Props

| Prop | Type | Description |
|------|------|-------------|
| `view` | `EditableView` | Existing view for edit mode |
| `model` | `ModelClass` | Model class for create mode |
| `defaultValues` | `Record<string, any>` | Default values for create mode |
| `editable` | `boolean` | Whether form is editable (default: true) |
| `activateOn` | `"field" \| "form" \| "trigger"` | How edit mode is activated |
| `onActivate` | `() => void` | Called when edit mode is activated |
| `onDeactivate` | `() => void` | Called when focus leaves with no dirty fields |
| `onCreate` | `(view) => void` | Called after successful create |
| `onSuccess` | `() => void` | Called after successful edit |
| `onError` | `(error) => void` | Called on error |

### Field Props

| Prop | Type | Description |
|------|------|-------------|
| `name` | `string` | Field name (must match entity property) |
| `label` | `string` | Label text |
| `type` | `FieldType` | Input type (default: "text") |
| `placeholder` | `string` | Placeholder text |
| `options` | `SelectOption[]` | Options for select type |
| `disabled` | `boolean` | Disable the field |
| `icon` | `ReactNode` | Icon for view mode display |

## License

MIT
