// CMS pages read by screens other than the footer (seeded like the footer
// pages: published with default text, never overwriting an admin's edits).
// Each FAQ question is a first line followed by its answer; blank lines
// separate questions.
module.exports = [
  {
    // Read by "List your property" (/list-your-property).
    slug: 'lister-faq',
    title: 'Questions from owners and builders',
    description: 'Listing with us: fees, privacy and the no-broker rule.',
    content: `Is listing really free?
Yes. You pay a pre-agreed commission only when a deal with a buyer we introduced is closed and verified.

Will buyers call me directly?
No. Your phone and email are never shown. Our sales team speaks to buyers, arranges visits and relays offers to you.

Can brokers list here?
No. Every lister passes KYC and signs a no-broker declaration. Accounts found brokering are suspended.`,
  },
];
