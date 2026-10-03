import { describe,it,expect } from 'vitest';
import { collectionGroup, COLLECTION_GROUPS } from '@/modules/official-ui/collection-groups';
import { parseSebiLegalListing } from '@/modules/official/adapters/regulators/sebi';
describe('quality-first navigation and source classification',()=>{
 it('separates judicial, regulatory, procedural and secondary records',()=>{
  expect(collectionGroup('sebi-orders','order')).toBe('decisions');
  expect(collectionGroup('sebi-orders','circular')).toBe('regulation');
  expect(collectionGroup('sci-causelist','cause_list')).toBe('practice');
  expect(collectionGroup('sansad','committee_report')).toBe('research');
  expect(collectionGroup('egazette','gazette')).toBeNull();
  expect(collectionGroup('sansad','parliament_question')).toBeNull();
  expect(COLLECTION_GROUPS).toHaveLength(4);
 });
 it('keeps the publisher edition label without inventing an exact date or legal verification',()=>{
  const r=parseSebiLegalListing('<table><tr><td>2015</td><td><a href="/legal/regulations/jul-2026/listing-regulations_100001.html">Listing Regulations, 2015 [Last amended on July 14, 2026]</a></td></tr></table>','regulations','https://www.sebi.gov.in/legal.html');
  expect(r).toHaveLength(1);expect(r[0]).toMatchObject({kind:'regulation',docDate:null,meta:{editionLabel:'Last amended on July 14, 2026',legalStatus:'not_independently_verified'}});
 });
 it('rejects Gazette links and off-domain documents instead of reintroducing retired collections',()=>{
  const h='<table><tr><td>Jan 30, 2026</td><td><a href="https://evil.test/legal/master-circulars/a.html">Wrong publisher</a></td></tr><tr><td>2026</td><td><a href="/legal/gazette-notification/a.html">Gazette</a></td></tr><tr><td>Jan 30, 2026</td><td><a href="/legal/master-circulars/jan-2026/master_99432.html">Master Circular</a></td></tr></table>';
  expect(parseSebiLegalListing(h,'master-circulars','https://www.sebi.gov.in/legal.html')).toMatchObject([{kind:'circular',docDate:'2026-01-30'}]);
 });
});

it('handles the optional closing td tags on the live SEBI master circular listing',()=>{const html='<table><tr role="row"><td>Sep 28, 2026</td><td><a href="https://www.sebi.gov.in/legal/master-circulars/sep-2026/master-circular-for-debenture-trustees_104743.html">Master Circular for Debenture Trustees</a></tr></table>';expect(parseSebiLegalListing(html,'master-circulars','https://www.sebi.gov.in/legal.html')).toMatchObject([{kind:'circular',docDate:'2026-09-28'}]);});
