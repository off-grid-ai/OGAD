// Word pools for generated pages. More variety here means more varied training data.

export const DOMAINS = [
  'acme-portal.test', 'northwind.test', 'bluepeak.test', 'cedar-bank.test', 'orbit-travel.test',
  'lumen-health.test', 'kite-hr.test', 'harbor-shop.test', 'pinecrest.test', 'quill-crm.test'
]

export const SITE_NAMES = [
  'Acme Portal', 'Northwind', 'BluePeak', 'Cedar Bank', 'Orbit Travel', 'Lumen Health', 'Kite HR',
  'Harbor Shop', 'Pinecrest', 'Quill CRM'
]

export const NAV_LINKS = ['Home', 'Dashboard', 'Reports', 'Help', 'Settings', 'Contact', 'Pricing', 'Blog', 'Account']

export const FIRST_NAMES = ['Asha', 'Rohan', 'Meera', 'Kabir', 'Leena', 'Arjun', 'Sara', 'Vikram', 'Noor', 'Dev', 'Isha', 'Tara']
export const LAST_NAMES = ['Rao', 'Shah', 'Iyer', 'Mehta', 'Khan', 'Das', 'Pillai', 'Kapoor', 'Nair', 'Bose']
export const CITIES = ['Pune', 'Mumbai', 'Chennai', 'Kochi', 'Jaipur', 'Indore', 'Nagpur', 'Surat', 'Mysuru', 'Goa']
export const COUNTRIES = ['India', 'Nepal', 'Sri Lanka', 'Singapore', 'Japan', 'Kenya', 'Brazil', 'Canada', 'Germany', 'Peru']
export const PRODUCTS = [
  'Desk Lamp', 'Office Chair', 'Water Bottle', 'Notebook Set', 'Wireless Mouse', 'USB Hub', 'Standing Desk',
  'Laptop Stand', 'Coffee Mug', 'Backpack', 'Monitor Arm', 'Keyboard', 'Headphones', 'Webcam', 'Plant Pot',
  'Wall Clock', 'Bookshelf', 'Floor Mat', 'Desk Fan', 'Cable Box'
]
export const STATUSES = ['Active', 'Pending', 'Archived', 'On hold', 'Shipped', 'Draft']

/** Field templates: label variants, kind, and how to make a value. */
export const FIELD_TEMPLATES = [
  { key: 'first', labels: ['First name', 'Given name', 'First Name'], kind: 'text', value: (r) => r.pick(FIRST_NAMES) },
  { key: 'last', labels: ['Last name', 'Surname', 'Family name'], kind: 'text', value: (r) => r.pick(LAST_NAMES) },
  { key: 'name', labels: ['Name', 'Full name', 'Contact name'], kind: 'text', value: (r) => `${r.pick(FIRST_NAMES)} ${r.pick(LAST_NAMES)}` },
  { key: 'email', labels: ['Email', 'Email address', 'Work email'], kind: 'email', value: (r) => `${r.pick(FIRST_NAMES).toLowerCase()}.${r.pick(LAST_NAMES).toLowerCase()}@example.com` },
  { key: 'phone', labels: ['Phone', 'Mobile number', 'Phone number'], kind: 'tel', value: (r) => `9${r.int(100000000, 999999999)}` },
  { key: 'city', labels: ['City', 'Town', 'City / Town'], kind: 'text', value: (r) => r.pick(CITIES) },
  { key: 'zip', labels: ['Postal code', 'PIN code', 'ZIP'], kind: 'text', value: (r) => String(r.int(110000, 899999)) },
  { key: 'qty', labels: ['Quantity', 'Qty', 'Number of items'], kind: 'number', value: (r) => String(r.int(1, 25)) },
  { key: 'guests', labels: ['Guests', 'Number of guests', 'Travellers'], kind: 'number', value: (r) => String(r.int(1, 8)) },
  { key: 'company', labels: ['Company', 'Organisation', 'Company name'], kind: 'text', value: (r) => `${r.pick(LAST_NAMES)} ${r.pick(['Labs', 'Traders', 'Foods', 'Systems'])}` },
  { key: 'notes', labels: ['Notes', 'Comments', 'Message', 'Description'], kind: 'textarea', value: (r) => r.pick(['Please call before delivery.', 'Leave at the front desk.', 'Urgent request.', 'No changes needed.']) },
  { key: 'country', labels: ['Country', 'Country / Region', 'Nationality'], kind: 'select', options: (r) => r.sample(COUNTRIES, r.int(4, 8)) },
  { key: 'priority', labels: ['Priority', 'Urgency'], kind: 'select', options: () => ['Low', 'Medium', 'High', 'Critical'] },
  { key: 'plan', labels: ['Plan', 'Subscription', 'Tier'], kind: 'radio', options: () => ['Free', 'Basic', 'Pro', 'Enterprise'] },
  { key: 'delivery', labels: ['Delivery', 'Shipping speed'], kind: 'radio', options: () => ['Standard', 'Express', 'Same day'] },
  { key: 'terms', labels: ['I accept the terms', 'Agree to terms and conditions', 'I agree to the policy'], kind: 'checkbox' },
  { key: 'news', labels: ['Send me updates', 'Subscribe to newsletter', 'Email me offers'], kind: 'checkbox' },
  { key: 'gift', labels: ['This is a gift', 'Add gift wrap'], kind: 'checkbox' }
]

export const SECTION_TITLES = [
  ['Billing', 'Shipping'],
  ['Primary contact', 'Secondary contact'],
  ['Sender', 'Recipient'],
  ['Personal details', 'Emergency contact'],
  ['Home address', 'Work address']
]

export const SINGLE_SECTION_TITLES = ['Your details', 'Account', 'Booking', 'Order', 'Profile', 'Request', 'Preferences']
export const SUBMIT_LABELS = ['Save', 'Submit', 'Continue', 'Update', 'Save changes', 'Place order', 'Send request']
export const TOGGLE_LABELS = ['Show more details', 'Add more information', 'More options', 'Expand section']
export const ROW_ACTIONS = ['Delete', 'Remove', 'Archive']
