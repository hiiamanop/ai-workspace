# System Design
> Design Philosophy for Enterprise Applications
>
> Version: 1.0

---

# Philosophy

The product should feel calm.

Users should never feel overwhelmed by information.

Every screen should answer one question:

> "What does the user need to do next?"

If a component does not help answer that question,
it should probably not exist.

The interface should disappear.

The work should become the focus.

---

# Core Principles

## 1. Simplicity First

Always prefer

Simple

over

Powerful-looking.

Bad

- too many cards
- too many charts
- too many colors
- too many actions

Good

- one clear CTA
- one clear hierarchy
- generous spacing

---

## 2. Information Hierarchy

Every page should follow

Primary

↓

Secondary

↓

Supporting

↓

Details

Never display all information with equal visual weight.

---

## 3. Whitespace

Whitespace is a feature.

Never try to fill empty areas.

The product should breathe.

Minimum spacing system

4
8
12
16
24
32
40
48
64

Use 8-point grid.

---

## 4. Typography

Typography carries hierarchy.

Do not rely on colors.

Font

Inter

Weights

400
500
600
700

Sizes

12
14
16
18
20
24
32
40

Never use more than 6 font sizes on one screen.

---

# Color System

Primary

#2563EB

Success

#22C55E

Warning

#F59E0B

Danger

#EF4444

Text Primary

#111827

Text Secondary

#6B7280

Border

#E5E7EB

Background

#FAFAFA

Surface

#FFFFFF

Never use decorative colors.

Color only communicates meaning.

---

# Elevation

Avoid heavy shadows.

Preferred

Border

1px

Very soft shadow

0 1px 2px rgba(0,0,0,.05)

Avoid

Large floating cards

---

# Border Radius

Inputs

10px

Cards

12px

Modal

16px

Buttons

10px

Keep radius consistent.

---

# Layout

Desktop

Sidebar

240px

Content

Max Width

1440px

Padding

32px

Section Gap

40px

Card Gap

24px

---

# Sidebar

Sidebar should contain only primary navigation.

Example

Overview

Projects

Customers

Documents

Analytics

Settings

Nothing more.

---

# Header

Contains

Title

Description

Primary Action

Profile

Notifications

Search

Avoid placing metrics inside header.

---

# Page Structure

Page

↓

Header

↓

Primary Metrics

↓

Main Content

↓

Supporting Content

↓

Table

---

# Cards

Every card contains

Title

Main Content

Optional Description

Optional Action

No unnecessary decorations.

---

# Metrics

Each metric consists of

Title

Large Value

Delta

Description

Example

Revenue

$18,400

↑ 12%

Compared to yesterday

---

# Tables

Tables should look like documents.

Minimal borders.

Hover only.

Avoid zebra striping.

Always support

Sorting

Filtering

Searching

Pagination

---

# Buttons

Primary

Filled

One per screen.

Secondary

Outline

Ghost

Text only.

Danger

Red.

Never place more than one Primary button in one viewport.

---

# Inputs

Height

44px

Rounded

10px

Always display labels.

Never rely only on placeholders.

---

# Dialog

Dialog width

Small

480

Medium

720

Large

960

Never exceed 80% viewport width.

---

# Empty State

Every empty state should explain

What happened

Why

What to do next

Include

Illustration

Title

Description

CTA

---

# Loading

Prefer Skeletons

Never use full page spinners.

Skeletons should match final layout.

---

# Notifications

Toast

Success

Top Right

Duration

3 seconds

Errors

Persistent until dismissed.

---

# Icons

Use Lucide Icons.

Sizes

16

18

20

24

Icons support text.

Never replace text.

---

# Motion

Animations should feel invisible.

Duration

150ms

200ms

250ms

Never exceed 300ms.

Use

Opacity

Transform

Scale

Avoid bouncing animations.

---

# Accessibility

Minimum touch target

44x44

Contrast

WCAG AA

Keyboard accessible

Visible focus state

Screen reader friendly

---

# Dashboard Philosophy

Dashboard is not a report.

Dashboard is a workspace.

The first screen should answer

What happened?

What needs attention?

What should I do next?

Nothing else.

---

# Visual Hierarchy

Large Numbers

↓

Charts

↓

Lists

↓

Tables

↓

Logs

---

# Charts

Only include charts when trends matter.

Avoid pie charts.

Prefer

Line

Bar

Area

Never display more than two charts on one page.

---

# Components

Foundation

Button

Input

Textarea

Checkbox

Radio

Switch

Badge

Avatar

Divider

Card

Tabs

Table

Dropdown

Tooltip

Popover

Modal

Drawer

Toast

Progress

Breadcrumb

Pagination

Calendar

Command Palette

---

# Design Tokens

Spacing

space-1 = 4

space-2 = 8

space-3 = 12

space-4 = 16

space-5 = 24

space-6 = 32

Radius

sm = 8

md = 10

lg = 12

xl = 16

Animation

fast = 150ms

normal = 200ms

slow = 250ms

---

# User Experience Rules

One primary action.

One clear hierarchy.

One purpose per screen.

Reduce cognitive load.

Prefer whitespace over decoration.

Prefer readability over density.

Prefer consistency over creativity.

Design should feel effortless.