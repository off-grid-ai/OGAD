"""Shared synthetic data for the data-family clones (sheets, docs, tables, blog). No real people."""
import random

FIRST = ['Aarav', 'Ananya', 'Rohan', 'Priya', 'Vikram', 'Kavya', 'Arjun', 'Meera', 'Ishaan', 'Diya', 'Kabir', 'Sanya',
         'Nikhil', 'Tara', 'Rahul', 'Neha', 'Siddharth', 'Pooja', 'Aditya', 'Riya', 'Farhan', 'Zoya', 'Karan', 'Nisha',
         'Emma', 'Liam', 'Olivia', 'Noah', 'Sofia', 'Lucas', 'Chloe', 'Mateo', 'Hannah', 'Daniel', 'Grace', 'Felix',
         'Yuki', 'Kenji', 'Amara', 'Tomasz', 'Ingrid', 'Rafael', 'Leila', 'Omar', 'Elena', 'Marco', 'Ayesha', 'Dev']
LAST = ['Sharma', 'Iyer', 'Menon', 'Kapoor', 'Reddy', 'Nair', 'Gupta', 'Banerjee', 'Desai', 'Joshi', 'Pillai', 'Rao',
        'Malhotra', 'Chatterjee', 'Kulkarni', 'Bhat', 'Sethi', 'Verma', 'Khan', 'Mehta', 'Fernandes', 'DSouza',
        'Smith', 'Okafor', 'Novak', 'Lindqvist', 'Moreau', 'Tanaka', 'Silva', 'Rossi', 'Schmidt', 'Haddad', 'Kowalski',
        'Johansson', 'Park', 'Nguyen', 'Brennan', 'Costa', 'Weber', 'Hughes']
CITIES = ['Mumbai', 'Bengaluru', 'Pune', 'Delhi', 'Hyderabad', 'Chennai', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Kochi',
          'London', 'Berlin', 'Singapore', 'Dubai', 'Toronto', 'Sydney', 'Amsterdam', 'Lisbon', 'Austin', 'Nairobi']
REGIONS = ['North', 'South', 'East', 'West', 'Central']
COMPANIES = ['Acme Logistics', 'Bluepeak Foods', 'Coral Health', 'Deccan Textiles', 'Everline Media', 'Fernway Travel',
             'Globex Retail', 'Harbor Analytics', 'Indigo Fintech', 'Juniper Labs', 'Kestrel Motors', 'Lotus Pharma',
             'Monsoon Studios', 'Nimbus Cloud', 'Orchid Hotels', 'Pinnacle Insurance', 'Quartz Energy', 'Redwood Builders',
             'Saffron Kitchens', 'Tidewater Shipping', 'Umbra Security', 'Vertex Education', 'Willow Fashion', 'Zenith Telecom',
             'Aurora Solar', 'Banyan Capital', 'Cobalt Robotics', 'Dhruva Aerospace', 'Ember Games', 'Fable Books']
PRODUCTS = ['Wireless Mouse', 'USB-C Hub', 'Standing Desk', 'Office Chair', 'Laptop Stand', 'Webcam HD', 'Noise-cancelling Headset',
            'Monitor 27in', 'Mechanical Keyboard', 'Desk Lamp', 'Whiteboard', 'Printer Paper A4', 'Toner Cartridge',
            'Ethernet Cable', 'Power Strip', 'Notebook Pack', 'Gel Pens', 'Stapler', 'Filing Cabinet', 'Router AX3000',
            'SSD 1TB', 'External HDD 2TB', 'Phone Mount', 'Coffee Beans 1kg', 'Water Bottles', 'First Aid Kit',
            'Projector', 'Conference Speaker', 'HDMI Cable', 'Label Maker', 'Shredder', 'Desk Organizer', 'Smart Plug',
            'Tablet 10in', 'Docking Station', 'Cable Ties', 'Bookshelf', 'Air Purifier', 'Microwave', 'Kettle']


def person(rng):
    return f'{rng.choice(FIRST)} {rng.choice(LAST)}'


def people(rng, n):
    out, seen = [], set()
    while len(out) < n:
        p = person(rng)
        if p not in seen:
            seen.add(p); out.append(p)
    return out


def slug(s):
    import re
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
