// Default text for the public CMS pages (RE-L-05), seeded as published so the
// footer links work on a fresh install. Admins edit them in Admin > Content;
// the seed never overwrites a page that already has content.
// Paragraphs are separated by a blank line (the public page renders them as <p>).
module.exports = [
  {
    slug: 'about',
    title: 'About us',
    description: 'A verified, no-broker property portal: every listing is checked and every buyer talks to our own sales team.',
    content: `We are a property portal built around one promise: every listing is real and every conversation is handled by our own team.

Owners, landlords and builders list with us directly. Before a listing goes live we check the lister's identity and ownership documents, and many listings also carry a photo or site verification badge from our field team.

Buyers and tenants never deal with outside brokers. When you enquire, a member of our in-house sales team calls you, arranges site visits and stays with you until the deal is done. The lister's contact details stay private, and so do yours.

We earn a commission from the lister only when a deal closes through us. Buyers and tenants pay us nothing.

We currently serve Pune and are expanding to more cities.`,
  },
  {
    slug: 'no-broker-policy',
    title: 'No-broker policy',
    description: 'Only owners, landlords and builders may list. Brokers and agents are not allowed to post properties.',
    content: `Only the owner, the landlord or the builder of a property may list it on our portal. Brokers, agents and resellers are not allowed to post listings, and listings found to be posted by them are removed.

Every lister completes an identity and ownership check before their first listing goes live. We may ask for more documents at any time.

All enquiries are handled by our own sales team. Listers agree not to work with a buyer or tenant we introduced through any other channel to avoid our commission (see the non-circumvention clause in the listing agreement).

If you think a listing breaks this policy, use "Report this listing" on the property page. Our team reviews every report.`,
  },
  {
    slug: 'terms',
    title: 'Terms of use',
    description: 'The terms that apply when you browse, enquire or list a property on this portal.',
    content: `By using this portal you agree to these terms. If you do not agree, please do not use the portal.

Listings. Listers are responsible for the accuracy of their listings. We check identity and ownership documents but we do not guarantee the title, condition or legal status of any property. Buyers and tenants should carry out their own checks before paying any money.

Enquiries. When you enquire, our sales team may call, message or email you about that enquiry and similar properties. You can stop marketing messages at any time.

Commission. Listers pay our commission as set out in the listing agreement they accept before their listing goes live, including the non-circumvention period. Buyers and tenants are not charged by us.

Acceptable use. You must not post false information, copy content from the portal in bulk, try to contact listers by going around our team, or misuse the portal in any way that breaks the law.

Changes. We may update these terms. The date of the latest version is shown on this page.

These terms are governed by the laws of India.`,
  },
  {
    slug: 'privacy',
    title: 'Privacy policy',
    description: 'What personal data we collect, why we use it, who sees it, and how to export or delete it.',
    content: `This policy explains how we handle your personal data under the Digital Personal Data Protection Act, 2023.

What we collect. Your name, phone number and email when you sign up or enquire; your enquiries, shortlists and saved searches; for listers, identity and ownership documents and billing details; and, only if you accept analytics cookies, how you use the portal.

Why we use it. To verify listers, to handle your enquiries and site visits, to send the notifications you choose, to issue invoices, and to keep the portal safe.

Who sees it. Buyer and lister contact details are never shown to each other; our sales team is the only contact between you. We share data with partners (for example a home-loan partner) only with your separate consent.

Consents. You can see and withdraw your consents, and choose which notifications you get, in Account > Privacy and Account > Notifications. Reply STOP to any WhatsApp message to stop WhatsApp updates.

Your rights. You can download a copy of your data or ask us to delete your account from Account > Privacy. Some records, such as invoices, are kept for as long as the law requires.

Cookies. Essential cookies keep you signed in. Analytics cookies are used only if you accept them in the cookie banner.

Contact. Write to us through the Contact page for any privacy question or complaint.`,
  },
  {
    slug: 'faq',
    title: 'FAQ',
    description: 'Answers to common questions from buyers, tenants and listers.',
    content: `Do I pay a brokerage fee?
No. Buyers and tenants do not pay us anything. Listers pay a commission only when a deal closes.

Why can't I see the owner's phone number?
To protect both sides, all conversations go through our sales team. They arrange visits and negotiations for you.

What do the verification badges mean?
"Verified Owner", "Verified Landlord" or "Verified Builder" means we checked the lister's ID and ownership documents. "Photo verified" and "Site verified" mean our team checked the photos or visited the property. Hover over a badge to see when.

How do I list my property?
Create an account, choose "List your property", complete the identity check and fill in the listing form. Our team reviews it before it goes live.

How long does approval take?
Most listings are reviewed within one working day.

How do I stop messages?
Change your choices in Account > Notifications, use the unsubscribe link in any email, or reply STOP on WhatsApp.`,
  },
  {
    // Read by "List your property" (/list-your-property). Each question is a
    // first line followed by its answer; blank lines separate questions.
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
  {
    slug: 'careers',
    title: 'Careers',
    description: 'Join our in-house sales and verification teams.',
    content: `We are growing our in-house sales, verification and support teams.

We look for people who know their city, enjoy helping families find a home, and want to work without the shortcuts of the traditional brokerage business.

To apply, send your CV and the role you are interested in through the Contact page. We reply to every application.`,
  },
];
