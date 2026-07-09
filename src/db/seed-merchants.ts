/**
 * Starter merchant→category map (mapping_source='seed'), the same way
 * commercial finance apps ship a base map. Grows from Claude results and
 * user corrections; user mappings always win (schema.md merchants).
 * Category values are "Parent > Sub" paths into the seeded taxonomy.
 */

export interface SeedMerchant {
  name: string;
  category: string;
  aliases: string[]; // matched contains-style against normalized descriptions
}

export const SEED_MERCHANTS: SeedMerchant[] = [
  // food
  { name: "Trader Joe's", category: "Food > Groceries", aliases: ["TRADER JOE"] },
  { name: "Whole Foods", category: "Food > Groceries", aliases: ["WHOLE FOODS", "WHOLEFDS"] },
  { name: "Safeway", category: "Food > Groceries", aliases: ["SAFEWAY"] },
  { name: "Costco", category: "Food > Groceries", aliases: ["COSTCO WHSE", "COSTCO"] },
  { name: "Starbucks", category: "Food > Coffee", aliases: ["STARBUCKS"] },
  { name: "Blue Bottle", category: "Food > Coffee", aliases: ["BLUE BOTTLE"] },
  { name: "Chipotle", category: "Food > Dining", aliases: ["CHIPOTLE"] },
  { name: "McDonald's", category: "Food > Dining", aliases: ["MCDONALD"] },
  { name: "Sweetgreen", category: "Food > Dining", aliases: ["SWEETGREEN"] },
  { name: "Joe's Pizza", category: "Food > Dining", aliases: ["JOES PIZZA"] },
  { name: "DoorDash", category: "Food > Delivery", aliases: ["DOORDASH"] },
  { name: "Uber Eats", category: "Food > Delivery", aliases: ["UBER EATS", "UBER *EATS"] },
  // transport
  { name: "Uber", category: "Transport > Rideshare", aliases: ["UBER TRIP", "UBER *TRIP"] },
  { name: "Lyft", category: "Transport > Rideshare", aliases: ["LYFT"] },
  { name: "Shell", category: "Transport > Gas", aliases: ["SHELL OIL", "SHELL SERVICE"] },
  { name: "Chevron", category: "Transport > Gas", aliases: ["CHEVRON"] },
  { name: "MTA", category: "Transport > Public Transit", aliases: ["MTA*NYCT", "MTA NYCT"] },
  // subscriptions
  { name: "Netflix", category: "Subscriptions > Streaming", aliases: ["NETFLIX"] },
  { name: "Spotify", category: "Subscriptions > Streaming", aliases: ["SPOTIFY"] },
  { name: "Apple", category: "Subscriptions > Software", aliases: ["APPLE.COM/BILL", "APPLE.COM BILL"] },
  { name: "iCloud", category: "Subscriptions > Software", aliases: ["ICLOUD"] },
  { name: "Amazon Prime", category: "Subscriptions > Memberships", aliases: ["AMZN PRIME", "AMAZON PRIME"] },
  { name: "Crunch Fitness", category: "Health > Fitness", aliases: ["CRUNCH FITNESS", "CRUNCH CLUB"] },
  // shopping
  { name: "Amazon", category: "Shopping > General", aliases: ["AMAZON MKTPL", "AMZN MKTP", "AMAZON.COM"] },
  { name: "Target", category: "Shopping > General", aliases: ["TARGET"] },
  { name: "Best Buy", category: "Shopping > Electronics", aliases: ["BEST BUY"] },
  { name: "Uniqlo", category: "Shopping > Clothing", aliases: ["UNIQLO"] },
  // housing & utilities
  { name: "Westview Apartments", category: "Housing > Rent", aliases: ["WESTVIEW APARTMENTS", "WESTVIEW APT"] },
  { name: "Con Edison", category: "Utilities > Electricity", aliases: ["CONED", "CON EDISON"] },
  { name: "Verizon", category: "Utilities > Mobile", aliases: ["VERIZON"] },
  { name: "Xfinity", category: "Utilities > Internet", aliases: ["XFINITY", "COMCAST"] },
  // health
  { name: "CVS", category: "Health > Pharmacy", aliases: ["CVS/PHARM", "CVS PHARMACY"] },
  { name: "Walgreens", category: "Health > Pharmacy", aliases: ["WALGREENS"] },
  // travel
  { name: "United Airlines", category: "Travel > Flights", aliases: ["UNITED AIRLINES", "UNITED 016"] },
  { name: "Delta", category: "Travel > Flights", aliases: ["DELTA AIR"] },
  { name: "Marriott", category: "Travel > Hotels", aliases: ["MARRIOTT"] },
  { name: "Airbnb", category: "Travel > Hotels", aliases: ["AIRBNB"] },
  // entertainment
  { name: "AMC Theatres", category: "Entertainment > Events", aliases: ["AMC #", "AMC THEATRES"] },
  { name: "Steam", category: "Entertainment > Games", aliases: ["STEAMGAMES", "STEAM PURCHASE"] },
  // income-ish / financial
  { name: "Acme Corp (payroll)", category: "Income > Salary", aliases: ["ACME CORP PAYROLL", "ACME PAYROLL"] },
  { name: "Robinhood Gold", category: "Fees > Bank Fees", aliases: ["GOLD MONTHLY FEE", "ROBINHOOD GOLD"] },
];
