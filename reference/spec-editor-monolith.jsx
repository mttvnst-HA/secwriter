import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { ChevronRight, ChevronDown, FileText, Plus, Type, Hash, Bookmark, Search } from "lucide-react";

// === EMBEDDED DOCUMENT DATA (parsed from 31_00_00.SEC) ===
const INITIAL_BLOCKS = [{"id": "n1", "type": "note", "part": 0, "depth": 0, "section": null, "html": "NOTE: This guide specification covers the requirements for earthwork activities for buildings, utilities, roadways, railroads, and airfields ."}, {"id": "n2", "type": "note", "part": 0, "depth": 0, "section": null, "html": "Adhere to <span class=\"mark-url\">UFC 1-300-02</span> Unified Facilities Guide Specifications (UFGS) Format Standard when editing this guide specification or preparing new project specification sections. Edit this guide specification for project speci..."}, {"id": "n3", "type": "note", "part": 0, "depth": 0, "section": null, "html": "Remove information and requirements not required in respective project, whether or not brackets are present."}, {"id": "n4", "type": "note", "part": 0, "depth": 0, "section": null, "html": "Comments, suggestions and recommended changes for this guide specification are welcome and should be submitted as a <span class=\"mark-url\">Criteria Change Request (CCR)</span> ."}, {"id": "n5", "type": "title", "part": 1, "depth": 0, "html": "PART 1 GENERAL"}, {"id": "n6", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "NOTE: Consult with an engineer while editing this section to determine specific requirements for each job."}, {"id": "n7", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "The following information will be indicated on the project drawings:"}, {"id": "n8", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "1. Surface elevations, existing and new;"}, {"id": "n9", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "2. Location of underground obstructions and existing utilities;"}, {"id": "n10", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "3. Location and record of soil borings and test pits. Include ground water observations and topsoil thickness encountered in boring, soil classifications, and properties such as moisture content and Atterberg limit determinations;"}, {"id": "n11", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "4. Location of borrow and disposal area if located on Government property;"}, {"id": "n12", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "5. Clearing stripping and grubbing limits, if different from clearing limits;"}, {"id": "n13", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "6. Areas to be seeded;"}, {"id": "n14", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "7. Hydrological data where available;"}, {"id": "n15", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "8. Shoring and sheeting required (trench protection is specified in Corps of Engineers Manual EM 385-1-1); and"}, {"id": "n16", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "9. Pipe trench excavation details;"}, {"id": "n17", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "10. Location and limits of hard material (obstructions or bedrock);"}, {"id": "n18", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "11. Details of special construction such as under railroad and highways right-of-way requirements for jacking and boring;"}, {"id": "n19", "type": "note", "part": 1, "depth": 0, "section": "n5", "html": "12. Details of sewage absorption trenches, absorption pits, and subsurface drains."}, {"id": "n20", "type": "title", "part": 1, "depth": 1, "html": "REFERENCES"}, {"id": "n21", "type": "note", "part": 1, "depth": 1, "section": "n20", "html": "NOTE: This paragraph is used to list the publications cited in the text of the guide specification. The publications are referred to in the text by basic designation only and listed in this paragraph by organization, designation, date, and title."}, {"id": "n22", "type": "note", "part": 1, "depth": 1, "section": "n20", "html": "Use the Reference Wizard's Check Reference feature when you add a Reference Identifier (RID) outside of the Section's Reference Article to automatically place the reference in the Reference Article. Also use the Reference Wizard's Check Reference fea..."}, {"id": "n23", "type": "note", "part": 1, "depth": 1, "section": "n20", "html": "References not used in the text will automatically be deleted from this section of the project specification when you choose to reconcile references in the publish print process."}, {"id": "n24", "type": "txt", "part": 1, "depth": 1, "section": "n20", "html": "The publications listed below form a part of this specification to the extent referenced. The publications are referred to within the text by the basic designation only."}, {"id": "n25", "type": "title", "part": 1, "depth": 1, "html": "DEFINITIONS"}, {"id": "n26", "type": "note", "part": 1, "depth": 1, "section": "n25", "html": "NOTE: Delete definitions that will not be used in the specification text or shown on the drawings for a specific project."}, {"id": "n27", "type": "note", "part": 1, "depth": 1, "section": "n25", "html": "All materials called out in the project plan set must be defined in this section."}, {"id": "n28", "type": "note", "part": 1, "depth": 1, "section": "n25", "html": "This list is not exhaustive, therefore will need to be tailored for each project."}, {"id": "n29", "type": "title", "part": 1, "depth": 2, "html": "Structural Fill"}, {"id": "n30", "type": "txt", "part": 1, "depth": 2, "section": "n29", "html": "Soil material placed to support buildings, walls, pads, and other similar facilities."}, {"id": "n31", "type": "title", "part": 1, "depth": 2, "html": "Embankment Fill"}, {"id": "n33", "type": "title", "part": 1, "depth": 2, "html": "Porous Fill"}, {"id": "n35", "type": "title", "part": 1, "depth": 2, "html": "Topsoil"}, {"id": "n37", "type": "title", "part": 1, "depth": 2, "html": "Utility Bedding Material"}, {"id": "n39", "type": "title", "part": 1, "depth": 2, "html": "Flowable Fill"}, {"id": "n41", "type": "title", "part": 1, "depth": 2, "html": "Satisfactory Materials"}, {"id": "n42", "type": "note", "part": 1, "depth": 2, "section": "n41", "html": "NOTE: Satisfactory material will be defined in accordance with locally available materials, design slopes, etc., and suitable classes, based on the geotechnical report, will be listed in the project specification in accordance with the Unified Soil C..."}, {"id": "n43", "type": "txt", "part": 1, "depth": 2, "section": "n41", "html": "Satisfactory materials for fill, backfill, and/or any in-situ soils to remain in place comprise any materials classified by <span class=\"mark-rid\">ASTM D2487</span> as [GW], [GP], [GM], [GP-GM], [GW-GM], [GC], [GP-GC], [GM-GC], [SW], [SP], [SM], [SW-..."}, {"id": "n44", "type": "title", "part": 1, "depth": 2, "html": "Unsatisfactory Materials"}, {"id": "n47", "type": "title", "part": 1, "depth": 2, "html": "Cohesionless Materials"}, {"id": "n48", "type": "note", "part": 1, "depth": 2, "section": "n47", "html": "NOTE: When classification will be necessary during construction, determination of grain size for classification will be specified to be made in conformance with ASTM C117, ASTM C136/C136M, and ASTM D1140. This paragraph should only be used where soil..."}, {"id": "n49", "type": "txt", "part": 1, "depth": 2, "section": "n47", "html": "Cohesionless materials include materials classified in <span class=\"mark-rid\">ASTM D2487</span> as GW, GP, SW, and SP. Materials classified as GM and SM will be identified as cohesionless only when the fines are nonplastic. Perform testing, required ..."}, {"id": "n50", "type": "title", "part": 1, "depth": 2, "html": "Cohesive Materials"}, {"id": "n53", "type": "title", "part": 1, "depth": 2, "html": "Hard/Unyielding Materials"}, {"id": "n56", "type": "title", "part": 1, "depth": 2, "html": "Unstable Material"}, {"id": "n58", "type": "title", "part": 1, "depth": 2, "html": "Expansive Soils"}, {"id": "n61", "type": "title", "part": 1, "depth": 2, "html": "Rock"}, {"id": "n62", "type": "txt", "part": 1, "depth": 2, "section": "n61", "html": "Solid homogeneous interlocking crystalline material with firmly cemented, laminated, or foliated masses or conglomerate deposits, neither of which can be removed without systematic drilling and blasting, drilling and the use of expansion jacks or fea..."}, {"id": "n63", "type": "title", "part": 1, "depth": 2, "html": "Capillary Water Barrier"}, {"id": "n65", "type": "title", "part": 1, "depth": 2, "html": "Degree of Compaction (Proctor)"}, {"id": "n66", "type": "note", "part": 1, "depth": 2, "section": "n65", "html": "NOTE: ASTM D1557 will be used for maximum dry density determinations, unless soil borings indicate a gradation that may include coarse material where more than 30 percent is retained on the <span class=\"mark-met\">19 mm</span> <span class=\"mark-eng\">3..."}, {"id": "n67", "type": "txt", "part": 1, "depth": 2, "section": "n65", "html": "Degree of compaction required, except as noted in the second sentence, is expressed as a percentage of the maximum dry density obtained by the test procedure presented in [ <span class=\"mark-rid\">ASTM D1557</span> ] [ <span class=\"mark-rid\">ASTM D698..."}, {"id": "n68", "type": "title", "part": 1, "depth": 2, "html": "Degree of Compaction (Relative Density)"}, {"id": "n70", "type": "title", "part": 1, "depth": 2, "html": "Overhaul"}, {"id": "n73", "type": "title", "part": 1, "depth": 2, "html": "Borrow"}, {"id": "n75", "type": "title", "part": 1, "depth": 2, "html": "Subgrade"}, {"id": "n77", "type": "title", "part": 1, "depth": 1, "html": "SUBSURFACE DATA"}, {"id": "n78", "type": "txt", "part": 1, "depth": 1, "section": "n77", "html": "Subsurface soil boring logs are shown [in project plans] [in an Attachment to these specifications] [_____]. These data represent available subsurface information; however, variations may exist between boring locations."}, {"id": "n79", "type": "title", "part": 1, "depth": 1, "html": "CRITERIA FOR BIDDING"}, {"id": "n80", "type": "note", "part": 1, "depth": 1, "section": "n79", "html": "NOTE: For most projects, the scope of earthwork can accurately be determined. However, if earthwork is approximately known, a unit price for earth work should be provided in the Bid Schedule."}, {"id": "n81", "type": "note", "part": 1, "depth": 1, "section": "n79", "html": "Measurement and Payment should be addressed with Section <span class=\"mark-srf\">01 20 00</span> PRICE AND PAYMENT PROCEDURES."}, {"id": "n82", "type": "note", "part": 1, "depth": 1, "section": "n79", "html": "Unit-price items are multiplied by the approximated and stated quantity giving a sum that is then added to the price for the rest of the work. The result is a lump sum bid with automatic provision for payment or credit due to variations in earthwork ..."}, {"id": "n83", "type": "note", "part": 1, "depth": 1, "section": "n79", "html": "Variations exceeding 15 percent of that shown and bid upon will become the subject of negotiations in accordance with FAR 52.211-18 Variation in Estimated Quantity."}, {"id": "n84", "type": "txt", "part": 1, "depth": 1, "section": "n79", "html": "Base bids on the following criteria:"}, {"id": "n85", "type": "oli", "part": 1, "depth": 1, "level": 1, "section": "n79", "html": "Surface elevations are as indicated."}, {"id": "n86", "type": "oli", "part": 1, "depth": 1, "level": 1, "section": "n79", "html": "Pipes or other artificial obstructions, except those indicated, will not be encountered."}, {"id": "n87", "type": "oli", "part": 1, "depth": 1, "level": 1, "section": "n79", "html": "[Ground water elevations indicated by the boring log were those existing at the time subsurface investigations were made and do not necessarily represent ground water elevation at the time of construction.][ Ground water elevation is [_____] <span cl..."}, {"id": "n88", "type": "oli", "part": 1, "depth": 1, "level": 1, "section": "n79", "html": "Ground water elevation is [_____] <span class=\"mark-met\">meters</span> <span class=\"mark-eng\">feet</span> below existing surface elevation."}, {"id": "n89", "type": "oli", "part": 1, "depth": 1, "level": 1, "section": "n79", "html": "Material character is indicated by the boring logs."}, {"id": "n90", "type": "note", "part": 1, "depth": 1, "section": "n79", "html": "NOTE: Choose the following option if no boring information is available, or if the boring information is insufficient to permit a bidder to develop an accurate estimate of hard material or rock to be encountered. If hard material or rock is to be enc..."}, {"id": "n91", "type": "oli", "part": 1, "depth": 1, "level": 1, "section": "n79", "html": "Hard materials[ and rock] [will not] [will] be encountered[ in [_____] percent of the excavations][ at [_____] <span class=\"mark-met\">meter</span> <span class=\"mark-eng\">s feet</span> below existing surface elevations]."}, {"id": "n92", "type": "title", "part": 1, "depth": 1, "html": "SUBMITTALS"}, {"id": "n93", "type": "note", "part": 1, "depth": 1, "section": "n92", "html": "NOTE: Review Submittal Description (SD) definitions in Section <span class=\"mark-srf\">01 33 00</span> SUBMITTAL PROCEDURES and edit the following list, and corresponding submittal items in the text, to reflect only the submittals required for the pro..."}, {"id": "n94", "type": "note", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-tai\">For Army projects, fill in the empty brackets following the \"G\" classification, with a code of up to three characters to indicate the approving authority. Codes for Army projects using the Resident Management System (RMS) are: ..."}, {"id": "n95", "type": "note", "part": 1, "depth": 1, "section": "n92", "html": "The \"S\" classification indicates submittals required as proof of compliance for sustainability Guiding Principles Validation or Third Party Certification and as described in Section <span class=\"mark-srf\">01 33 00</span> SUBMITTAL PROCEDURES."}, {"id": "n96", "type": "txt", "part": 1, "depth": 1, "section": "n92", "html": "Government approval is required for submittals with a \"G\" or \"S\" classification. <span class=\"mark-tai\">Submittals not having a \"G\" or \"S\" classification are for Contractor Quality Control approval.</span> <span class=\"mark-tai\">Submittals not having..."}, {"id": "n97", "type": "lst", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">SD-01 Preconstruction Submittals</span>"}, {"id": "n98", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Excavation and Trenching Plan</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n99", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Borrow Plan</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n100", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Dewatering Work Plan</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n101", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Jacking, Boring, and Tunneling Plan</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n102", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Rock Excavation Plan</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n103", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Blasting Plan</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n104", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Disposition of Surplus Materials</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n105", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Preconstruction Meeting</span> ; <span class=\"mark-sub\">G</span>"}, {"id": "n106", "type": "lst", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">SD-03 Product Data</span>"}, {"id": "n107", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Flowable Fill Mix Design</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n108", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Geotextiles</span>"}, {"id": "n109", "type": "lst", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">SD-04 Samples</span>"}, {"id": "n110", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Geotextiles</span>"}, {"id": "n111", "type": "lst", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">SD-06 Test Reports</span>"}, {"id": "n112", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Dewatering Performance Records</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n113", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Material Test Report</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n114", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Borrow Site Testing</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n115", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Pipe Inspection Report</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n116", "type": "item", "part": 1, "depth": 1, "section": "n92", "html": "<span class=\"mark-sub\">Geotechnical Evaluation Report</span> ; <span class=\"mark-sub\">G <span class=\"mark-tai\">, [_____]</span></span>"}, {"id": "n117", "type": "title", "part": 1, "depth": 1, "html": "QUALITY CONTROL"}, {"id": "n118", "type": "title", "part": 1, "depth": 2, "html": "Geotechnical Engineer"}, {"id": "n121", "type": "title", "part": 1, "depth": 2, "html": "Qualified Technician"}, {"id": "n123", "type": "title", "part": 1, "depth": 2, "html": "Lab Validation"}, {"id": "n125", "type": "title", "part": 1, "depth": 2, "html": "Preconstruction Meeting"}, {"id": "n128", "type": "title", "part": 2, "depth": 0, "html": "PART 2 PRODUCTS"}, {"id": "n129", "type": "note", "part": 2, "depth": 0, "section": "n128", "html": "NOTE: All PRODUCTS included must have an associated definition in PART 1."}, {"id": "n130", "type": "title", "part": 2, "depth": 1, "html": "SOIL MATERIALS"}, {"id": "n131", "type": "note", "part": 2, "depth": 1, "section": "n130", "html": "NOTE: All SOIL MATERIALS included must have an associated definition in PART 1. Soil materials as described in this subpart should be called out where applicable on project plan sets. Soil materials should expand upon definition to include required c..."}, {"id": "n132", "type": "note", "part": 2, "depth": 1, "section": "n130", "html": "For example, the following is a list of material properties/criteria that could be considered for specific soil materials such as Embankment Fill:"}, {"id": "n133", "type": "note", "part": 2, "depth": 1, "section": "n130", "html": "a. Liquid limit less than [_____]; b. Plasticity index [greater than] [less than] [_____]; c. Hydraulic conductivity (ASTM D5084) to be [less than] [greater than] or equal to [_____]; and d. Grain size analysis resulting in greater than [_____] perce..."}, {"id": "n134", "type": "title", "part": 2, "depth": 2, "html": "Structural Fill"}, {"id": "n135", "type": "txt", "part": 2, "depth": 2, "section": "n134", "html": "Materials classified as [GW], [GP],[GM], [GC], [GW-GM], [GW-GC], [GP-GM], [GP-GC], [GC-GM], [SW], [SP], [SM], [SW-SM], [SC], [SW-SC], [SP-SM], [SP-SC], [CL], or [CH] in accordance with <span class=\"mark-rid\">ASTM D2487</span> . Select material type a..."}, {"id": "n136", "type": "title", "part": 2, "depth": 2, "html": "Embankment Fill"}, {"id": "n137", "type": "txt", "part": 2, "depth": 2, "section": "n136", "html": "Materials classified as [GW], [GP], [GM], [GC], [GW-GM], [GW-GC], [GP-GM], [GP-GC], [GC-GM], [SW], [SP], [SM], [SW-SM], [SC], [SW-SC], [SP-SM], [SP-SC], [CL], or [CH] in accordance with <span class=\"mark-rid\">ASTM D2487</span> . Select material type ..."}, {"id": "n138", "type": "title", "part": 2, "depth": 2, "html": "Porous Fill"}, {"id": "n139", "type": "txt", "part": 2, "depth": 2, "section": "n138", "html": "Materials containing less than 5 percent passing the No. 200 sieve. Provide the gradation as appropriate for the intended purpose."}, {"id": "n140", "type": "title", "part": 2, "depth": 2, "html": "Topsoil"}, {"id": "n141", "type": "note", "part": 2, "depth": 2, "section": "n140", "html": "NOTE: Additional requirements such as pH value and necessary soil conditioning, according to applicable provisions of Sections <span class=\"mark-srf\">32 92 19</span> SEEDING through <span class=\"mark-srf\">32 92 26</span> SPRIGGING, should be inserted..."}, {"id": "n142", "type": "txt", "part": 2, "depth": 2, "section": "n140", "html": "Material suitable for topsoil obtained from [offsite areas] [excavations] [areas indicated on the drawings] is defined as: Natural, friable soil representative of productive, well-drained soils in the area, free of subsoil, stumps, rocks larger than ..."}, {"id": "n143", "type": "title", "part": 2, "depth": 2, "html": "Capillary Water Barrier"}, {"id": "n144", "type": "txt", "part": 2, "depth": 2, "section": "n143", "html": "Conform to <span class=\"mark-rid\">ASTM C33/C33M</span> for fine aggregate grading with a maximum of 3 percent by weight passing <span class=\"mark-rid\">ASTM D1140</span> , <span class=\"mark-met\">75 micrometers</span> <span class=\"mark-eng\">No. 200</sp..."}, {"id": "n145", "type": "title", "part": 2, "depth": 2, "html": "Utility Bedding Material"}, {"id": "n146", "type": "txt", "part": 2, "depth": 2, "section": "n145", "html": "Except as specified otherwise in the individual piping section, provide bedding for buried piping in accordance with [ <span class=\"mark-rid\">AWWA C600</span> ] [ <span class=\"mark-rid\">ASTM D2321</span> ]. Install bedding for plastic piping to sprin..."}, {"id": "n147", "type": "title", "part": 2, "depth": 3, "html": "Class I"}, {"id": "n148", "type": "txt", "part": 2, "depth": 3, "section": "n147", "html": "Angular, <span class=\"mark-met\">6 to 40 mm</span> <span class=\"mark-eng\">0.25 to 1.5 inch</span> , graded stone, including a number of fill materials that have regional significance such as coral, slag, cinders, crushed stone, and crushed shells."}, {"id": "n149", "type": "title", "part": 2, "depth": 3, "html": "Class II"}, {"id": "n150", "type": "txt", "part": 2, "depth": 3, "section": "n149", "html": "Coarse sands and gravels with maximum particle size of <span class=\"mark-met\">40 mm</span> <span class=\"mark-eng\">1.5 inch</span> , including various graded sands and gravels containing small percentages of fines, generally granular and noncohesive, ..."}, {"id": "n151", "type": "title", "part": 2, "depth": 3, "html": "Sand"}, {"id": "n152", "type": "txt", "part": 2, "depth": 3, "section": "n151", "html": "Clean, coarse-grained sand classified as [_____], [gradation [_____] of the [DOT] [State Standard] or [SW] [or] [SP] by <span class=\"mark-rid\">ASTM D2487</span> for [bedding] [and] [backfill] [as indicated]]."}, {"id": "n153", "type": "title", "part": 2, "depth": 3, "html": "Gravel and Crushed Stone"}, {"id": "n154", "type": "txt", "part": 2, "depth": 3, "section": "n153", "html": "Clean, coarsely graded natural gravel, crushed stone or a combination thereof identified as [_____], [gradation [_____] of the [DOT] [State Standard]] or having a classification of [GW] [GP] in accordance with <span class=\"mark-rid\">ASTM D2487</span>..."}, {"id": "n155", "type": "title", "part": 2, "depth": 1, "html": "FLOWABLE FILL"}, {"id": "n156", "type": "txt", "part": 2, "depth": 1, "section": "n155", "html": "Design and submit <span class=\"mark-sub\">flowable fill mix design</span> to consist of Portland cement, fly ash, and/or slag cement and fine aggregate. Include the dry weights of cementitious material(s); quality and gradation of aggregates in the sa..."}, {"id": "n157", "type": "title", "part": 2, "depth": 1, "html": "BURIED WARNING AND IDENTIFICATION MARKERS"}, {"id": "n158", "type": "note", "part": 2, "depth": 1, "section": "n157", "html": "NOTE: Delete paragraph if tape is not required in the project. The use of a plastic warning tape for identification is mandatory for buried hazardous utilities such as electrical conduit, gas lines, fuel lines, high pressure nitrogen, high pressure w..."}, {"id": "n159", "type": "txt", "part": 2, "depth": 1, "section": "n157", "html": "Provide [polyethylene plastic] [and] [metallic core or metallic-faced, acid- and alkali-resistant, polyethylene plastic] warning tape manufactured specifically for warning and identification of buried utility lines. Provide tape on rolls, <span class..."}, {"id": "n160", "type": "table", "part": 2, "depth": 1, "section": "n157", "table": {"columns": 2, "rows": [[{"text": "Warning Tape Color Codes", "colspan": 2}], [{"text": "Red", "colspan": 1}, {"text": "Electric", "colspan": 1}], [{"text": "Yellow", "colspan": 1}, {"text": "Gas, Oil; Dangerous Materials", "colspan": 1}], [{"text": "Orange", "colspan": 1}, {"text": "Telephone and Other Communications", "colspan": 1}], [{"text": "Blue", "colspan": 1}, {"text": "Water Systems", "colspan": 1}], [{"text": "Green", "colspan": 1}, {"text": "Sewer Systems", "colspan": 1}], [{"text": "White", "colspan": 1}, {"text": "Steam Systems", "colspan": 1}], [{"text": "Gray", "colspan": 1}, {"text": "Compressed Air", "colspan": 1}]]}}, {"id": "n161", "type": "title", "part": 2, "depth": 2, "html": "Warning Tape for Metallic Piping"}, {"id": "n162", "type": "txt", "part": 2, "depth": 2, "section": "n161", "html": "Provide acid and alkali-resistant polyethylene plastic tape conforming to the width, color, and printing requirements specified above, with a minimum thickness of <span class=\"mark-met\">0.08 mm</span> <span class=\"mark-eng\">0.003 inch</span> and a mi..."}, {"id": "n163", "type": "title", "part": 2, "depth": 2, "html": "Detectable Warning Tape for Non-Metallic Piping"}, {"id": "n164", "type": "txt", "part": 2, "depth": 2, "section": "n163", "html": "Provide polyethylene plastic tape conforming to the width, color, and printing requirements specified above, with a minimum thickness of <span class=\"mark-met\">0.10 mm</span> <span class=\"mark-eng\">0.004 inch</span> , and a minimum strength of <span ..."}, {"id": "n165", "type": "title", "part": 2, "depth": 2, "html": "Detection Wire for Non-Metallic Piping"}, {"id": "n167", "type": "title", "part": 2, "depth": 1, "html": "MATERIAL FOR RIP-RAP"}, {"id": "n170", "type": "title", "part": 2, "depth": 2, "html": "Bedding Material"}, {"id": "n172", "type": "title", "part": 2, "depth": 2, "html": "Grout"}, {"id": "n174", "type": "title", "part": 2, "depth": 2, "html": "Rock"}, {"id": "n177", "type": "title", "part": 2, "depth": 1, "html": "BORROW"}, {"id": "n179", "type": "title", "part": 2, "depth": 1, "html": "GEOTEXTILE"}, {"id": "n182", "type": "title", "part": 3, "depth": 0, "html": "PART 3 EXECUTION"}, {"id": "n183", "type": "title", "part": 3, "depth": 1, "html": "PROTECTION"}, {"id": "n195", "type": "title", "part": 3, "depth": 2, "html": "Underground Utilities"}, {"id": "n197", "type": "title", "part": 3, "depth": 2, "html": "Drainage and Dewatering"}, {"id": "n200", "type": "title", "part": 3, "depth": 3, "html": "Drainage"}, {"id": "n202", "type": "title", "part": 3, "depth": 3, "html": "Dewatering"}, {"id": "n205", "type": "title", "part": 3, "depth": 2, "html": "Shoring and Sheeting"}, {"id": "n207", "type": "title", "part": 3, "depth": 2, "html": "Protection of Graded Surfaces"}, {"id": "n209", "type": "title", "part": 3, "depth": 1, "html": "BORROW"}, {"id": "n212", "type": "title", "part": 3, "depth": 2, "html": "Government Furnished Borrow Area(s)"}, {"id": "n216", "type": "title", "part": 3, "depth": 3, "html": "Stripping and Stockpiling Operations in Borrow Area"}, {"id": "n219", "type": "title", "part": 3, "depth": 3, "html": "Drainage of Borrow Excavations"}, {"id": "n221", "type": "title", "part": 3, "depth": 3, "html": "Borrow Area Closure"}, {"id": "n223", "type": "title", "part": 3, "depth": 2, "html": "Contractor Furnished Borrow Area(s)"}, {"id": "n226", "type": "title", "part": 3, "depth": 2, "html": "Environmental Requirements for Off-Site Soil"}, {"id": "n230", "type": "title", "part": 3, "depth": 1, "html": "SURFACE PREPARATION"}, {"id": "n231", "type": "title", "part": 3, "depth": 2, "html": "Clearing and Grubbing"}, {"id": "n234", "type": "title", "part": 3, "depth": 2, "html": "Stripping"}, {"id": "n238", "type": "title", "part": 3, "depth": 2, "html": "Proof Rolling"}, {"id": "n242", "type": "title", "part": 3, "depth": 2, "html": "Stockpiling Operations"}, {"id": "n245", "type": "title", "part": 3, "depth": 1, "html": "EXCAVATION"}, {"id": "n248", "type": "title", "part": 3, "depth": 2, "html": "Ditches, Gutters, and Channel Changes"}, {"id": "n250", "type": "title", "part": 3, "depth": 2, "html": "Trench Excavation Requirements"}, {"id": "n253", "type": "title", "part": 3, "depth": 3, "html": "Bottom Preparation"}, {"id": "n256", "type": "title", "part": 3, "depth": 3, "html": "Removal of Unyielding Material"}, {"id": "n259", "type": "title", "part": 3, "depth": 3, "html": "Removal of Unstable Material"}, {"id": "n261", "type": "title", "part": 3, "depth": 3, "html": "Excavation for Appurtenances"}, {"id": "n263", "type": "title", "part": 3, "depth": 3, "html": "Gas Distribution"}, {"id": "n265", "type": "title", "part": 3, "depth": 3, "html": "Water Lines"}, {"id": "n268", "type": "title", "part": 3, "depth": 2, "html": "Jacking, Boring, and Tunneling"}, {"id": "n273", "type": "title", "part": 3, "depth": 3, "html": "Pipeline Casing"}, {"id": "n275", "type": "title", "part": 3, "depth": 3, "html": "Bore Holes"}, {"id": "n277", "type": "title", "part": 3, "depth": 3, "html": "Cleaning"}, {"id": "n279", "type": "title", "part": 3, "depth": 3, "html": "End Seals"}, {"id": "n281", "type": "title", "part": 3, "depth": 2, "html": "Underground Utilities"}, {"id": "n284", "type": "title", "part": 3, "depth": 2, "html": "Structural Excavation"}, {"id": "n289", "type": "title", "part": 3, "depth": 2, "html": "Pile Cap Excavation"}, {"id": "n291", "type": "title", "part": 3, "depth": 2, "html": "Rock Excavation and Blasting"}, {"id": "n293", "type": "title", "part": 3, "depth": 1, "html": "SUBGRADE PREPARATION"}, {"id": "n294", "type": "title", "part": 3, "depth": 2, "html": "General Requirements"}, {"id": "n297", "type": "title", "part": 3, "depth": 2, "html": "Subgrade for Structures, Spread Footings, and Concrete Slabs"}, {"id": "n299", "type": "title", "part": 3, "depth": 2, "html": "Subgrade for Railroads"}, {"id": "n301", "type": "title", "part": 3, "depth": 2, "html": "Subgrade for Pavements"}, {"id": "n303", "type": "title", "part": 3, "depth": 2, "html": "Subgrade for Shoulders"}, {"id": "n305", "type": "title", "part": 3, "depth": 2, "html": "Subgrade for Airfield Pavements"}, {"id": "n308", "type": "title", "part": 3, "depth": 2, "html": "Subgrade Filter Fabric"}, {"id": "n310", "type": "title", "part": 3, "depth": 1, "html": "FILLING AND COMPACTION"}, {"id": "n319", "type": "title", "part": 3, "depth": 2, "html": "Trench Backfill"}, {"id": "n322", "type": "title", "part": 3, "depth": 3, "html": "Replacement of Unyielding Material"}, {"id": "n324", "type": "title", "part": 3, "depth": 3, "html": "Replacement of Unstable Material"}, {"id": "n326", "type": "title", "part": 3, "depth": 3, "html": "Bedding and Initial Backfill"}, {"id": "n331", "type": "title", "part": 3, "depth": 3, "html": "Final Backfill"}, {"id": "n334", "type": "title", "part": 3, "depth": 4, "html": "Buildings[, Railroads][, Airfields] and Pavements"}, {"id": "n336", "type": "title", "part": 3, "depth": 4, "html": "Turfed or Seeded Areas and Miscellaneous Areas"}, {"id": "n338", "type": "title", "part": 3, "depth": 3, "html": "Heat Distribution System"}, {"id": "n340", "type": "title", "part": 3, "depth": 3, "html": "Electrical Distribution System"}, {"id": "n342", "type": "title", "part": 3, "depth": 3, "html": "Sewage Absorption Trenches or Pits"}, {"id": "n344", "type": "title", "part": 3, "depth": 4, "html": "Porous Fill"}, {"id": "n346", "type": "title", "part": 3, "depth": 4, "html": "Cover"}, {"id": "n349", "type": "title", "part": 3, "depth": 3, "html": "Displacement of Features"}, {"id": "n352", "type": "title", "part": 3, "depth": 3, "html": "Buried Tape And Detection Wire"}, {"id": "n353", "type": "title", "part": 3, "depth": 4, "html": "Buried Warning and Identification Tape"}, {"id": "n355", "type": "title", "part": 3, "depth": 4, "html": "Buried Detection Wire"}, {"id": "n357", "type": "title", "part": 3, "depth": 2, "html": "Structural Fill Placement"}, {"id": "n359", "type": "title", "part": 3, "depth": 2, "html": "Backfill for Appurtenances"}, {"id": "n362", "type": "title", "part": 3, "depth": 2, "html": "Porous Fill Placement"}, {"id": "n364", "type": "title", "part": 3, "depth": 2, "html": "Flowable Fill"}, {"id": "n366", "type": "title", "part": 3, "depth": 2, "html": "Compaction"}, {"id": "n368", "type": "title", "part": 3, "depth": 3, "html": "General Site"}, {"id": "n370", "type": "title", "part": 3, "depth": 3, "html": "Adjacent Areas"}, {"id": "n372", "type": "title", "part": 3, "depth": 1, "html": "EMBANKMENTS"}, {"id": "n373", "type": "title", "part": 3, "depth": 2, "html": "Earth Embankments"}, {"id": "n378", "type": "title", "part": 3, "depth": 2, "html": "Rock Embankments"}, {"id": "n383", "type": "title", "part": 3, "depth": 1, "html": "RIP-RAP CONSTRUCTION"}, {"id": "n386", "type": "title", "part": 3, "depth": 2, "html": "Bedding Placement"}, {"id": "n388", "type": "title", "part": 3, "depth": 2, "html": "Stone Placement"}, {"id": "n390", "type": "title", "part": 3, "depth": 2, "html": "Grouting"}, {"id": "n392", "type": "title", "part": 3, "depth": 1, "html": "FINISHING/FINISH OPERATIONS"}, {"id": "n396", "type": "title", "part": 3, "depth": 2, "html": "Capillary Water Barrier"}, {"id": "n399", "type": "title", "part": 3, "depth": 2, "html": "Grading Around Structures"}, {"id": "n401", "type": "title", "part": 3, "depth": 2, "html": "Shoulder Construction"}, {"id": "n404", "type": "title", "part": 3, "depth": 2, "html": "Grading"}, {"id": "n406", "type": "title", "part": 3, "depth": 2, "html": "Topsoil and Seed"}, {"id": "n410", "type": "title", "part": 3, "depth": 1, "html": "DISPOSITION OF SURPLUS MATERIAL"}, {"id": "n413", "type": "title", "part": 3, "depth": 1, "html": "TESTING"}, {"id": "n416", "type": "table", "part": 3, "depth": 1, "section": "n413", "table": {"columns": 3, "rows": [[{"text": "Material Type", "colspan": 1}, {"text": "Location of Material", "colspan": 1}, {"text": "Test Frequency", "colspan": 1}], [{"text": "Undisturbed native soil", "colspan": 1}, {"text": "Structures", "colspan": 1}, {"text": "Two random tests in building footings and two tests on subgrade within building line", "colspan": 1}], [{"text": "Fills and backfills", "colspan": 1}, {"text": "Structures (adjacent to)", "colspan": 1}, {"text": "One test per structure per <span class=\"mark-met\">200 sq m</span> <span class=\"mark-eng\">2000 sq ft</span> taken <span class=\"mark-met\">300 mm</span> <span class=\"mark-eng\">1 foot</span> below finished grade", "colspan": 1}], [{"text": "Subgrades", "colspan": 1}, {"text": "Site (except airfields)", "colspan": 1}, {"text": "One test per <span class=\"mark-met\">250 sq m</span> <span class=\"mark-eng\">2500 sq ft</span>", "colspan": 1}], [{"text": "Embankments or borrow", "colspan": 1}, {"text": "Any", "colspan": 1}, {"text": "One test per lift per <span class=\"mark-met\">400 cubic m</span> <span class=\"mark-eng\">500 cubic yds</span> placed", "colspan": 1}], [{"text": "Native soil subgrade other than structures and parking", "colspan": 1}, {"text": "Any", "colspan": 1}, {"text": "One test or one test per <span class=\"mark-met\">900 sq m</span> <span class=\"mark-eng\">10,000 sq ft</span> whichever is greater", "colspan": 1}], [{"text": "Borrow", "colspan": 1}, {"text": "Any", "colspan": 1}, {"text": "One test per lift per <span class=\"mark-met\">400 cubic m</span> <span class=\"mark-eng\">500 cubic yds</span> placed", "colspan": 1}]]}}, {"id": "n419", "type": "table", "part": 3, "depth": 1, "section": "n413", "table": {"columns": 4, "rows": [[{"text": "Material Type [list materials to be tested as identified in paragraph DEFINITIONS]", "colspan": 1}, {"text": "Location of Material", "colspan": 1}, {"text": "Test Method", "colspan": 1}, {"text": "Test Frequency", "colspan": 1}], [{"text": "", "colspan": 1}, {"text": "", "colspan": 1}, {"text": "Density - [ <span class=\"mark-rid\">ASTM D1556/D1556M</span> ] [ <span class=\"mark-rid\">ASTM D2167</span> ] [ <span class=\"mark-rid\">ASTM D6938</span> ] [ <span class=\"mark-rid\">ASTM D8167/D8167M</span> ]. [When <span class=\"mark-rid\">ASTM D6938</span> or <span class=\"mark-rid\">ASTM D8167/D8167M</span> is used, check the calibration curves and adjust using only the sand cone method as described in <span class=\"mark-rid\">ASTM D1556/D1556M</span> .]", "colspan": 1}, {"text": "One test per [2000] [_____] square <span class=\"mark-met\">meters</span> <span class=\"mark-eng\">feet</span> , or fraction thereof, of each lift of fill or backfill areas compacted by other than hand-operated machines. Double testing frequency for areas compacted by hand-operated machines. [If <span class=\"mark-rid\">ASTM D6938</span> or <span class=\"mark-rid\">ASTM D8167/D8167M</span> is used, check in-place densities by <span class=\"mark-rid\">ASTM D1556/D1556M</span> as follows: One check test per lift for every [6] [10] tests.] [Where <span class=\"mark-rid\">ASTM D8167/D8167M</span> is used, provide water content verification in accordance with <span class=\"mark-rid\">ASTM D2216</span> for each test.]", "colspan": 1}], [{"text": "", "colspan": 1}, {"text": "", "colspan": 1}, {"text": "Moisture Content - <span class=\"mark-rid\">ASTM D2216</span>", "colspan": 1}, {"text": "Two tests per day for each type of fill and backfill. Sample taken immediately prior to compaction after moisture conditioning.", "colspan": 1}], [{"text": "", "colspan": 1}, {"text": "", "colspan": 1}, {"text": "Moisture Density Relationship - [ <span class=\"mark-rid\">ASTM D698</span> ][ <span class=\"mark-rid\">ASTM D1557</span> ]", "colspan": 1}, {"text": "One representative test per [500][_____] cubic <span class=\"mark-met\">meters</span> <span class=\"mark-eng\">yards</span> of fill and backfill, or when any change in material occurs which may affect the optimum moisture content or laboratory maximum dry density. Sample to be taken from stockpile or location of placement.", "colspan": 1}], [{"text": "", "colspan": 1}, {"text": "", "colspan": 1}, {"text": "Relative Density - <span class=\"mark-rid\">ASTM D4253</span> and <span class=\"mark-rid\">ASTM D4254</span>", "colspan": 1}, {"text": "One test per [2000] [_____] square <span class=\"mark-met\">meters</span> <span class=\"mark-eng\">feet</span> , or fraction thereof, of each lift of fill or backfill areas compacted by other than hand-operated machines. Double testing frequency for areas compacted by hand-operated machines.", "colspan": 1}], [{"text": "", "colspan": 1}, {"text": "", "colspan": 1}, {"text": "Gradation - <span class=\"mark-rid\">ASTM C136/C136M</span>", "colspan": 1}, {"text": "One representative test per [500][_____] cubic <span class=\"mark-met\">meters</span> <span class=\"mark-eng\">yards</span> of fill and backfill, or when any change in material occurs which may affect the optimum moisture content or laboratory maximum dry density. Sample to be taken from stockpile or location of placement.", "colspan": 1}], [{"text": "", "colspan": 1}, {"text": "", "colspan": 1}, {"text": "Atterberg Limits - <span class=\"mark-rid\">ASTM D4318</span>", "colspan": 1}, {"text": "One representative test per [500][_____] cubic <span class=\"mark-met\">meters</span> <span class=\"mark-eng\">yards</span> of fill and backfill, or when any change in material occurs which may affect the optimum moisture content or laboratory maximum dry density. Sample to be taken from stockpile or location of placement.", "colspan": 1}], [{"text": "", "colspan": 1}, {"text": "", "colspan": 1}, {"text": "Organic Content Test - <span class=\"mark-rid\">ASTM D2974</span> , Method C", "colspan": 1}, {"text": "One representative test per [200] [_____] lineal <span class=\"mark-met\">[meters]</span> <span class=\"mark-eng\">[feet]</span> of embankment.", "colspan": 1}]]}}];

// ============================================================
// SECTION NUMBERING
// ============================================================
function computeNumbering(blocks) {
  const titles = blocks.filter(b => b.type === "title");
  const numberMap = {};
  // counters[0] = part counter, counters[1] = depth-1 counter, etc.
  const counters = [0, 0, 0, 0, 0, 0, 0];
  let currentPart = 0;

  for (const t of titles) {
    const isPart = t.html.startsWith("PART ");
    if (isPart) {
      currentPart++;
      // Reset all sub-counters
      for (let i = 1; i < counters.length; i++) counters[i] = 0;
      // PART titles keep their existing text (PART 1, PART 2, etc.)
      numberMap[t.id] = null; // no prefix needed, text already has it
    } else {
      const d = t.depth; // 1-based depth within part (depth 1 = X.Y)
      if (d >= 1 && d < counters.length) {
        counters[d]++;
        // Reset all deeper counters
        for (let i = d + 1; i < counters.length; i++) counters[i] = 0;
        // Build number string: partNum.counter1.counter2...
        const parts = [currentPart];
        for (let i = 1; i <= d; i++) {
          parts.push(counters[i]);
        }
        numberMap[t.id] = parts.join(".");
      }
    }
  }
  return numberMap;
}

// ============================================================
// OLI LABEL COMPUTATION
// ============================================================
function computeOliLabels(blocks) {
  // OLI items get alternating letter/number labels: a,b,c (level 1), 1,2,3 (level 2)
  const labelMap = {};
  let counter = 0;
  let prevWasListContent = false;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "oli") {
      const level = b.level || 1;
      counter++;
      if (level === 1) {
        labelMap[b.id] = String.fromCharCode(96 + Math.min(counter, 26)) + ".";
      } else {
        labelMap[b.id] = counter + ".";
      }
      prevWasListContent = true;
    } else if (b.type === "note") {
      // Notes between OLI items don't reset the counter
    } else if (b.type === "lst") {
      // List header resets the counter for the following list items
      counter = 0;
      prevWasListContent = true;
    } else {
      // Any other block type (txt, title, item, table) resets the counter
      if (prevWasListContent) {
        counter = 0;
        prevWasListContent = false;
      }
    }
  }
  return labelMap;
}

// ============================================================
// TREE BUILDING
// ============================================================
function buildTree(blocks) {
  const titles = blocks.filter(b => b.type === "title");
  const root = { id: "root", children: [], text: "Section 31 00 00 - EARTHWORK", depth: -1 };
  const stack = [root];

  for (const t of titles) {
    const node = { id: t.id, text: t.html, depth: t.depth, part: t.part, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= t.depth) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

// ============================================================
// TREE NODE COMPONENT
// ============================================================
function TreeNode({ node, selectedId, onSelect, depth = 0, numberMap }) {
  const [expanded, setExpanded] = useState(node.depth <= 0);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedId === node.id;

  const isPart = node.text.startsWith("PART ");
  const isUpperCase = node.text === node.text.toUpperCase() && !isPart;
  const sectionNum = numberMap && numberMap[node.id];

  return (
    <div>
      <div
        onClick={() => {
          onSelect(node.id);
          if (hasChildren) setExpanded(!expanded);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 8px",
          paddingLeft: depth * 16 + 8,
          cursor: "pointer",
          borderRadius: 4,
          fontSize: isPart ? 13 : isUpperCase ? 12 : 12,
          fontWeight: isPart ? 700 : isUpperCase ? 600 : 400,
          letterSpacing: isPart || isUpperCase ? "0.02em" : 0,
          color: isSelected ? "#f0f0f0" : isPart ? "#c8d6e5" : "#94a3b8",
          backgroundColor: isSelected ? "rgba(99,132,168,0.25)" : "transparent",
          borderLeft: isSelected ? "2px solid #6384a8" : "2px solid transparent",
          transition: "all 0.15s ease",
        }}
        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.backgroundColor = "rgba(99,132,168,0.1)"; }}
        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.backgroundColor = "transparent"; }}
      >
        {hasChildren ? (
          expanded ? <ChevronDown size={14} style={{ flexShrink: 0, opacity: 0.5 }} /> : <ChevronRight size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sectionNum && <span style={{ opacity: 0.6, marginRight: 5, fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11 }}>{sectionNum}</span>}
          {isPart ? node.text : node.text.replace(/^PART \d+\s*/, "")}
        </span>
      </div>
      {expanded && hasChildren && node.children.map(child => (
        <TreeNode key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} numberMap={numberMap} />
      ))}
    </div>
  );
}

// ============================================================
// INLINE MARK LEGEND
// ============================================================
function MarkLegend() {
  const marks = [
    { cls: "mark-rid", label: "Ref Standard", example: "ASTM D2487" },
    { cls: "mark-srf", label: "Section Ref", example: "01 33 00" },
    { cls: "mark-sub", label: "Submittal", example: "SD-01" },
    { cls: "mark-eng", label: "English Units", example: "3 inches" },
    { cls: "mark-met", label: "Metric Units", example: "75 mm" },
  ];
  return (
    <div style={{ display: "flex", gap: 12, padding: "8px 16px", borderBottom: "1px solid #e2e8f0", fontSize: 11, color: "#64748b", flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontWeight: 600, marginRight: 4 }}>Data Elements:</span>
      {marks.map(m => (
        <span key={m.cls} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span className={m.cls} style={{ padding: "1px 5px", borderRadius: 3, fontSize: 11 }}>{m.example}</span>
          <span>{m.label}</span>
        </span>
      ))}
    </div>
  );
}

// ============================================================
// SLASH COMMAND MENU
// ============================================================
const SLASH_ITEMS = [
  { type: "title", label: "Heading", desc: "Section heading (Tab/Shift+Tab to change level)", icon: "H" },
  { type: "txt", label: "Paragraph", desc: "Plain text paragraph", icon: "\u00b6" },
  { type: "note", label: "Designer Note", desc: "Note to the designer (not in published spec)", icon: "\u2709" },
  { type: "oli", label: "Ordered List", desc: "Lettered list item (a. b. c.)", icon: "a." },
  { type: "item", label: "List Item", desc: "Bulleted list item", icon: "\u2022" },
  { type: "lst", label: "List Header", desc: "Submittal group header (e.g. SD-01)", icon: "\u2630" },
];

function SlashMenu({ filter, selectedIdx, onSelect, position }) {
  const filtered = SLASH_ITEMS.filter(item => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return item.label.toLowerCase().startsWith(q);
  });

  if (filtered.length === 0) return null;

  const safeIdx = Math.min(selectedIdx, filtered.length - 1);

  return (
    <div style={{
      position: "absolute",
      left: position.left || 15,
      top: position.top || 28,
      zIndex: 1000,
      backgroundColor: "#ffffff",
      border: "1px solid #e2e8f0",
      borderRadius: 8,
      boxShadow: "0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)",
      width: 280,
      padding: "4px 0",
      overflow: "hidden",
    }}>
      <div style={{ padding: "6px 12px 4px", fontSize: 10, color: "#94a3b8", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        Insert block
      </div>
      {filtered.map((item, i) => (
        <div
          key={item.type}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item.type);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "7px 12px",
            cursor: "pointer",
            backgroundColor: i === safeIdx ? "#f1f5f9" : "transparent",
            borderLeft: i === safeIdx ? "2px solid #6384a8" : "2px solid transparent",
            transition: "background 0.1s",
          }}
          onMouseEnter={e => e.currentTarget.style.backgroundColor = "#f8fafc"}
          onMouseLeave={e => e.currentTarget.style.backgroundColor = i === safeIdx ? "#f1f5f9" : "transparent"}
        >
          <span style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            backgroundColor: "#f1f5f9",
            border: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            fontWeight: 700,
            color: "#475569",
            flexShrink: 0,
          }}>
            {item.icon}
          </span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>{item.label}</div>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>{item.desc}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// EDITABLE BLOCK COMPONENT
// ============================================================
function EditableBlock({ block, onUpdate, onEnterKey, isFocused, onFocus, oliLabel, onDelete, onFocusPrev, onFocusNext, onConvertBlock }) {
  const ref = useRef(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);

  // Ref callback - fires the instant React attaches the DOM node
  const editable = block.type === "txt" || block.isNew;
  const setRef = useCallback((node) => {
    ref.current = node;
    if (!node) return;
    // Initialize content
    if (editable && block.html && !node.dataset.init) {
      node.innerHTML = block.html;
      node.dataset.init = "1";
    } else if (!editable) {
      node.innerHTML = block.html;
    }
  }, [editable]);

  // For new/converted blocks: place caret after mount + paint
  const needsFocus = block.isNew && editable;
  useEffect(() => {
    if (needsFocus && ref.current) {
      // Insert zero-width space so browser has a text node to anchor the caret
      if (!ref.current.textContent) {
        ref.current.innerHTML = "\u200B";
      }
      ref.current.focus();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      // Clean up the zero-width space on first real input
      const cleanup = () => {
        if (ref.current) {
          const content = ref.current.textContent || "";
          if (content.includes("\u200B")) {
            // Preserve cursor position by replacing ZWS without resetting content
            const sel = window.getSelection();
            const cursorOffset = sel.rangeCount ? sel.getRangeAt(0).startOffset : 0;
            ref.current.textContent = content.replace(/\u200B/g, "");
            // Restore cursor
            if (ref.current.childNodes.length > 0) {
              const range = document.createRange();
              const newOffset = Math.max(0, cursorOffset - 1);
              range.setStart(ref.current.childNodes[0], Math.min(newOffset, ref.current.textContent.length));
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        }
        ref.current?.removeEventListener("input", cleanup);
      };
      ref.current.addEventListener("input", cleanup);
    }
  }, []);

  function isCursorAtStart() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false;
    // Check if we're at the very beginning
    const preRange = document.createRange();
    preRange.setStart(ref.current, 0);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString().length === 0;
  }

  function isCursorAtEnd() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false;
    const postRange = document.createRange();
    postRange.setStart(range.endContainer, range.endOffset);
    postRange.setEnd(ref.current, ref.current.childNodes.length);
    return postRange.toString().length === 0;
  }

  function isEmpty() {
    if (!ref.current) return true;
    const text = (ref.current.textContent || "").replace(/\u200B/g, "");
    return text.trim().length === 0;
  }

  // Get filtered slash items count for index clamping
  const slashFiltered = useMemo(() => {
    if (!slashOpen) return [];
    return SLASH_ITEMS.filter(item => {
      if (!slashFilter) return true;
      const q = slashFilter.toLowerCase();
      return item.label.toLowerCase().startsWith(q);
    });
  }, [slashOpen, slashFilter]);

  const converting = useRef(false);

  function handleSlashSelect(type) {
    converting.current = true; // prevent blur from triggering state updates
    setSlashOpen(false);
    setSlashFilter("");
    setSlashIdx(0);
    if (ref.current) ref.current.textContent = "";
    onConvertBlock(block.id, type);
  }

  const handleBlur = useCallback(() => {
    if (converting.current) return; // skip blur during slash menu conversion
    if (ref.current) {
      onUpdate(block.id, ref.current.innerHTML);
    }
    setTimeout(() => {
      setSlashOpen(false);
      setSlashFilter("");
    }, 150);
  }, [block.id, onUpdate]);

  const handleKeyDown = useCallback((e) => {
    // Slash menu navigation
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx(i => Math.min(i + 1, slashFiltered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (slashFiltered.length > 0) {
          handleSlashSelect(slashFiltered[Math.min(slashIdx, slashFiltered.length - 1)].type);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        setSlashFilter("");
        return;
      }
      // Let other keys through to update the filter via onInput
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (ref.current) onUpdate(block.id, ref.current.innerHTML);
      onEnterKey(block.id);
      return;
    }

    if (e.key === "Backspace" && isEmpty()) {
      e.preventDefault();
      onDelete(block.id);
      return;
    }

    if (e.key === "ArrowUp" && isCursorAtStart()) {
      e.preventDefault();
      if (ref.current) onUpdate(block.id, ref.current.innerHTML);
      onFocusPrev(block.id);
      return;
    }

    if (e.key === "ArrowDown" && isCursorAtEnd()) {
      e.preventDefault();
      if (ref.current) onUpdate(block.id, ref.current.innerHTML);
      onFocusNext(block.id);
      return;
    }
  }, [block.id, onEnterKey, onUpdate, onDelete, onFocusPrev, onFocusNext, slashOpen, slashFiltered, slashIdx]);

  // Detect slash commands via input monitoring
  const handleInput = useCallback(() => {
    if (!ref.current) return;
    const text = (ref.current.textContent || "").replace(/\u200B/g, "");

    if (text.startsWith("/")) {
      const filter = text.slice(1);
      setSlashOpen(true);
      setSlashFilter(filter);
      setSlashIdx(0);
    } else {
      if (slashOpen) {
        setSlashOpen(false);
        setSlashFilter("");
      }
    }
  }, [slashOpen]);

  const isNote = block.type === "note";
  const isTxt = block.type === "txt";
  const isOli = block.type === "oli";
  const isItem = block.type === "item";
  const isLst = block.type === "lst";
  const isNew = block.isNew;

  // Margins from section.ini (inches converted to px at ~96 DPI)
  // These are absolute per block type, not cumulative with depth
  const MARGINS = {
    txt: 15,    // TXT=0.16"
    note: 85,   // NPR=0.89" (note paragraph content)
    item: 82,   // ITM=0.85"
    lst: 48,    // LST=0.50"
    oli: 48,    // OLI=0.50"
  };
  const leftMargin = MARGINS[block.type] || 15;

  const baseStyle = {
    padding: isTxt ? "6px 12px" : isNote ? "6px 12px" : "4px 12px",
    marginLeft: leftMargin,
    marginBottom: 2,
    fontSize: 14,
    lineHeight: "1.65",
    outline: "none",
    borderRadius: 3,
    minHeight: 24,
    transition: "background 0.15s ease",
  };

  if (isNote) {
    Object.assign(baseStyle, {
      borderLeft: "3px solid #f59e0b",
      backgroundColor: "#fffbeb",
      color: "#92400e",
      fontStyle: "normal",
      marginBottom: 4,
      marginRight: 85,  // NPR=0.89,0.89 - equal indent both sides
      padding: "6px 12px 6px 14px",
    });
  } else if (isLst) {
    Object.assign(baseStyle, {
      fontWeight: 600,
      color: "#334155",
      marginTop: 8,
      paddingLeft: 0,  // Align list header text at margin, left of OLI labels
    });
  } else if (isItem) {
    Object.assign(baseStyle, {
      color: "#334155",
      paddingLeft: 20,
      position: "relative",
    });
  } else if (isOli) {
    Object.assign(baseStyle, {
      color: "#334155",
      paddingLeft: 28,  // room for the a. b. c. label
    });
  } else {
    // txt or any new block type not matched above
    Object.assign(baseStyle, {
      color: "#1e293b",
      backgroundColor: isFocused ? "#f8fafc" : "transparent",
    });
  }

  return (
    <div style={{ position: "relative" }}>
      {isItem && (
        <span style={{
          position: "absolute",
          left: MARGINS.item + 4,
          top: 6,
          color: "#94a3b8",
          fontSize: 10,
          userSelect: "none",
        }}>&#9679;</span>
      )}
      {isOli && oliLabel && (
        <span style={{
          position: "absolute",
          left: MARGINS.oli - 4,
          top: 5,
          color: "#475569",
          fontSize: 14,
          fontWeight: 500,
          userSelect: "none",
          width: 24,
          textAlign: "right",
        }}>{oliLabel}</span>
      )}
      <div
        ref={setRef}
        data-block-id={block.id}
        contentEditable={editable}
        suppressContentEditableWarning
        onKeyDown={editable ? handleKeyDown : undefined}
        onInput={editable ? handleInput : undefined}
        onBlur={editable ? handleBlur : undefined}
        onClick={() => onFocus(block.id)}
        style={{
          ...baseStyle,
          cursor: editable ? "text" : "default",
          border: isFocused && editable ? "1px solid #cbd5e1" : "1px solid transparent",
          boxShadow: isFocused && editable ? "0 0 0 2px rgba(99,132,168,0.15)" : "none",
        }}
      />
      {slashOpen && editable && (
        <SlashMenu
          filter={slashFilter}
          selectedIdx={slashIdx}
          onSelect={handleSlashSelect}
          position={{ left: leftMargin + 12, top: 32 }}
        />
      )}
    </div>
  );
}

// ============================================================
// TITLE BLOCK COMPONENT
// ============================================================
function TitleBlock({ block, onFocus, isFocused, sectionNum, onUpdate, onPromote, onDemote, onEnterKey, onDelete, onFocusPrev, onFocusNext }) {
  const ref = useRef(null);
  const initialized = useRef(false);
  const isPart = block.html.startsWith("PART ");
  const depth = block.depth;
  const displayText = isPart ? block.html : block.html;

  useEffect(() => {
    if (ref.current && !initialized.current && !isPart) {
      ref.current.textContent = displayText;
      initialized.current = true;
    }
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        onPromote(block.id);
      } else {
        onDemote(block.id);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (ref.current) onUpdate(block.id, ref.current.textContent);
      onEnterKey(block.id);
      return;
    }
    if (e.key === "Backspace") {
      const text = ref.current ? ref.current.textContent.trim() : "";
      if (text.length === 0) {
        e.preventDefault();
        onDelete(block.id);
        return;
      }
    }
    if (e.key === "ArrowUp") {
      const sel = window.getSelection();
      if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
        const range = sel.getRangeAt(0);
        const pre = document.createRange();
        pre.setStart(ref.current, 0);
        pre.setEnd(range.startContainer, range.startOffset);
        if (pre.toString().length === 0) {
          e.preventDefault();
          if (ref.current) onUpdate(block.id, ref.current.textContent);
          onFocusPrev(block.id);
        }
      }
      return;
    }
    if (e.key === "ArrowDown") {
      const sel = window.getSelection();
      if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
        const range = sel.getRangeAt(0);
        const post = document.createRange();
        post.setStart(range.endContainer, range.endOffset);
        post.setEnd(ref.current, ref.current.childNodes.length);
        if (post.toString().length === 0) {
          e.preventDefault();
          if (ref.current) onUpdate(block.id, ref.current.textContent);
          onFocusNext(block.id);
        }
      }
      return;
    }
  }, [block.id, onUpdate, onPromote, onDemote, onEnterKey, onDelete, onFocusPrev, onFocusNext]);

  const handleBlur = useCallback(() => {
    if (ref.current && !isPart) {
      onUpdate(block.id, ref.current.textContent);
    }
  }, [block.id, onUpdate, isPart]);

  const style = {
    fontFamily: "'Georgia', 'Cambria', serif",
    fontWeight: isPart ? 800 : depth === 1 ? 700 : 600,
    fontSize: isPart ? 18 : depth === 1 ? 15 : 14,
    textTransform: depth <= 1 ? "uppercase" : "none",
    letterSpacing: isPart ? "0.04em" : depth === 1 ? "0.02em" : 0,
    color: isPart ? "#0f172a" : depth === 1 ? "#1e293b" : "#334155",
    padding: isPart ? "20px 12px 8px" : depth === 1 ? "16px 12px 4px" : "10px 12px 2px",
    marginLeft: 0,
    borderBottom: isPart ? "2px solid #1e293b" : depth === 1 ? "1px solid #e2e8f0" : "none",
    cursor: "text",
    borderRadius: 3,
    backgroundColor: isFocused ? "#f1f5f9" : "transparent",
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    outline: "none",
  };

  return (
    <div
      id={`block-${block.id}`}
      style={style}
      onClick={() => onFocus(block.id)}
    >
      {sectionNum && (
        <span style={{
          color: "#6384a8",
          fontFamily: "'SF Mono', 'Consolas', monospace",
          fontSize: isPart ? 18 : depth === 1 ? 14 : 13,
          fontWeight: 700,
          flexShrink: 0,
          minWidth: depth === 1 ? 40 : depth === 2 ? 56 : depth === 3 ? 72 : 88,
          userSelect: "none",
        }}>
          {sectionNum}
        </span>
      )}
      {isPart ? (
        <span>{displayText}</span>
      ) : (
        <span
          ref={ref}
          data-block-id={block.id}
          contentEditable
          suppressContentEditableWarning
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          style={{ outline: "none", flex: 1, minWidth: 20 }}
        />
      )}
      {isFocused && !isPart && (
        <span style={{
          fontSize: 10,
          color: "#94a3b8",
          whiteSpace: "nowrap",
          userSelect: "none",
          flexShrink: 0,
        }}>
          Tab/Shift+Tab to change level
        </span>
      )}
    </div>
  );
}

// ============================================================
// TABLE BLOCK COMPONENT
// ============================================================
function TableBlock({ block }) {
  const tbl = block.table;
  if (!tbl || !tbl.rows || tbl.rows.length === 0) return null;

  // Detect if first row is a header (single cell spanning all columns, or all cells have text)
  const firstRow = tbl.rows[0];
  const isCaption = firstRow.length === 1 && firstRow[0].colspan > 1;
  const headerRowIdx = isCaption ? 1 : 0;
  const captionText = isCaption ? firstRow[0].text : null;
  const dataRows = tbl.rows.slice(isCaption ? 1 : 0);
  const headerRow = dataRows[0];
  const bodyRows = dataRows.slice(1);

  // Determine if first data row looks like a header (all cells have text, short-ish)
  const firstRowIsHeader = headerRow && headerRow.every(c => c.text && c.text.length < 80);

  return (
    <div style={{
      marginLeft: 15,   // TAB not in [MARGINS] - inherits from parent TXT=0.16,0
      marginRight: 0,   // TXT right margin is 0
      paddingLeft: 12,  // Match TXT padding so table border aligns with text edge
      marginTop: 12,
      marginBottom: 12,
    }}>
      {captionText && (
        <div
          style={{
            textAlign: "center",
            fontWeight: 700,
            fontSize: 14,
            padding: "8px 12px",
            backgroundColor: "#f1f5f9",
            border: "1px solid #cbd5e1",
            borderBottom: "none",
          }}
          dangerouslySetInnerHTML={{ __html: captionText }}
        />
      )}
      <table style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 13,
        lineHeight: "1.5",
      }}>
        {firstRowIsHeader && (
          <thead>
            <tr>
              {headerRow.map((cell, ci) => (
                <th
                  key={ci}
                  colSpan={cell.colspan > 1 ? cell.colspan : undefined}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #cbd5e1",
                    backgroundColor: "#f1f5f9",
                    fontWeight: 600,
                    textAlign: "left",
                    color: "#334155",
                  }}
                  dangerouslySetInnerHTML={{ __html: cell.text }}
                />
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {(firstRowIsHeader ? bodyRows : dataRows).map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  colSpan={cell.colspan > 1 ? cell.colspan : undefined}
                  style={{
                    padding: "5px 10px",
                    border: "1px solid #cbd5e1",
                    verticalAlign: "top",
                    color: "#1e293b",
                  }}
                  dangerouslySetInnerHTML={{ __html: cell.text || "&nbsp;" }}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
export default function SpecEditor() {
  const [blocks, setBlocks] = useState(INITIAL_BLOCKS);
  const [selectedTreeId, setSelectedTreeId] = useState(null);
  const [focusedBlockId, setFocusedBlockId] = useState(null);
  const editorRef = useRef(null);
  const tree = useMemo(() => buildTree(blocks), [blocks]);
  const numberMap = useMemo(() => computeNumbering(blocks), [blocks]);
  const oliLabels = useMemo(() => computeOliLabels(blocks), [blocks]);

  // Programmatic focus for EXISTING elements (arrow nav, tree select, delete-focus-prev)
  // New blocks focus themselves via the ref callback in EditableBlock
  const focusBlock = useCallback((id, atEnd = true) => {
    setFocusedBlockId(id);
    // setTimeout(0) lets React finish any pending state updates first
    setTimeout(() => {
      const el = document.querySelector(`[data-block-id="${id}"]`);
      if (el) {
        el.focus();
        const range = document.createRange();
        const sel = window.getSelection();
        if (el.childNodes.length > 0) {
          range.selectNodeContents(el);
          range.collapse(atEnd);
        }
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }, 0);
  }, []);

  // Click focus - just update the visual highlight, let browser handle native cursor
  const handleClickFocus = useCallback((id) => {
    setFocusedBlockId(id);
  }, []);

  const handleTreeSelect = useCallback((id) => {
    setSelectedTreeId(id);
    focusBlock(id);
    const el = document.getElementById(`block-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focusBlock]);

  const handleBlockUpdate = useCallback((id, html) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
  }, []);

  const handleEnterKey = useCallback((afterId) => {
    const newId = `new-${Date.now()}`;
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === afterId);
      if (idx === -1) return prev;
      const current = prev[idx];

      // Enter on an empty list item exits back to paragraph
      const isEmpty = !(current.html || "").replace(/\u200B/g, "").trim();
      if (isEmpty && (current.type === "oli" || current.type === "item")) {
        const next = [...prev];
        next[idx] = { ...current, type: "txt", isNew: true, id: newId };
        return next;
      }

      // Propagate type for list-like blocks
      const propagateTypes = { oli: "oli", item: "item" };
      const newType = propagateTypes[current.type] || "txt";

      const newBlock = {
        id: newId,
        type: newType,
        part: current.part,
        depth: current.depth,
        section: current.section,
        level: current.level,
        html: "",
        isNew: true,
      };
      const next = [...prev];
      next.splice(idx + 1, 0, newBlock);
      return next;
    });
    setFocusedBlockId(newId);
  }, []);

  // Delete a block and focus the previous one
  const handleDelete = useCallback((blockId) => {
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      if (idx <= 0) return prev; // don't delete first block
      const prevBlock = prev[idx - 1];
      const next = prev.filter(b => b.id !== blockId);
      // Focus previous block
      setTimeout(() => focusBlock(prevBlock.id, true), 0);
      return next;
    });
  }, [focusBlock]);

  // A block is focusable if it's a title or an editable text block
  const isFocusable = useCallback((block) => {
    if (block.type === "title") return true;
    if (block.type === "txt" || block.isNew) return true;
    return false;
  }, []);

  // Navigate to previous editable block
  const handleFocusPrev = useCallback((blockId) => {
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      if (idx <= 0) return prev;
      for (let i = idx - 1; i >= 0; i--) {
        if (isFocusable(prev[i])) {
          setTimeout(() => focusBlock(prev[i].id, true), 0);
          break;
        }
      }
      return prev;
    });
  }, [focusBlock, isFocusable]);

  // Navigate to next editable block
  const handleFocusNext = useCallback((blockId) => {
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      if (idx < 0 || idx >= prev.length - 1) return prev;
      for (let i = idx + 1; i < prev.length; i++) {
        if (isFocusable(prev[i])) {
          setTimeout(() => focusBlock(prev[i].id, false), 0);
          break;
        }
      }
      return prev;
    });
  }, [focusBlock, isFocusable]);

  // Convert a text block to a title
  const handleConvertToTitle = useCallback((blockId) => {
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      if (idx < 0) return prev;
      const block = prev[idx];
      // Determine appropriate depth - look at surrounding titles
      let depth = 1;
      for (let i = idx - 1; i >= 0; i--) {
        if (prev[i].type === "title") {
          depth = prev[i].depth + 1;
          break;
        }
      }
      depth = Math.min(depth, 6);
      const next = [...prev];
      next[idx] = { ...block, type: "title", depth, isNew: false };
      return next;
    });
    setTimeout(() => focusBlock(blockId, true), 0);
  }, [focusBlock]);

  // General block type conversion (from slash menu)
  const handleConvertBlock = useCallback((blockId, newType) => {
    if (newType === "title") {
      handleConvertToTitle(blockId);
      return;
    }
    // Replace with a brand new block (new ID) so it goes through the exact same
    // mount path as Enter-created blocks, which we know works for focus
    const newId = `new-${Date.now()}`;
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      if (idx < 0) return prev;
      const block = prev[idx];
      const next = [...prev];
      next[idx] = {
        id: newId,
        type: newType,
        part: block.part,
        depth: block.depth,
        section: block.section,
        html: "",
        isNew: true,
      };
      return next;
    });
    setFocusedBlockId(newId);
  }, [handleConvertToTitle]);

  // Promote a title (decrease depth)
  const handlePromote = useCallback((blockId) => {
    setBlocks(prev => prev.map(b => {
      if (b.id === blockId && b.type === "title" && b.depth > 1) {
        return { ...b, depth: b.depth - 1 };
      }
      return b;
    }));
  }, []);

  // Demote a title (increase depth)
  const handleDemote = useCallback((blockId) => {
    setBlocks(prev => prev.map(b => {
      if (b.id === blockId && b.type === "title" && b.depth < 6) {
        return { ...b, depth: b.depth + 1 };
      }
      return b;
    }));
  }, []);

  const sectionNumber = "31 00 00";
  const sectionTitle = "EARTHWORK";
  const ufgsDate = "August 2023";

  return (
    <div style={{
      display: "flex",
      height: "100vh",
      fontFamily: "'Segoe UI', 'Helvetica Neue', -apple-system, sans-serif",
      backgroundColor: "#f8fafc",
      overflow: "hidden",
    }}>
      {/* CSS for inline marks */}
      <style>{`
        .mark-rid {
          background: #fae8ff;
          color: #86198f;
          padding: 0 3px;
          border-radius: 2px;
          font-weight: 500;
          font-size: 13px;
          font-family: 'SF Mono', 'Consolas', monospace;
        }
        .mark-srf {
          background: #f5d0fe;
          color: #701a75;
          padding: 0 4px;
          border-radius: 2px;
          font-weight: 600;
          font-size: 13px;
          font-family: 'SF Mono', 'Consolas', monospace;
          border-bottom: 2px solid #c026d3;
        }
        .mark-sub {
          background: #dbeafe;
          color: #1e40af;
          padding: 0 3px;
          border-radius: 2px;
          font-weight: 500;
        }
        .mark-eng {
          background: #dbeafe;
          color: #1d4ed8;
          padding: 0 3px;
          border-radius: 2px;
          font-size: 13px;
        }
        .mark-met {
          background: #fee2e2;
          color: #b91c1c;
          padding: 0 3px;
          border-radius: 2px;
          font-size: 13px;
        }
        .mark-tai {
          background: #cffafe;
          color: #0e7490;
          padding: 0 3px;
          border-radius: 2px;
        }
        .mark-tst {
          background: #fee2e2;
          color: #991b1b;
          padding: 0 3px;
          border-radius: 2px;
          font-weight: 500;
        }
        .mark-url {
          color: #2563eb;
          text-decoration: underline;
          cursor: pointer;
        }
        [contenteditable]:empty:before {
          content: "Type here or press / for block types...";
          color: #94a3b8;
          font-style: italic;
        }
        [contenteditable]:focus {
          outline: none;
        }
        ::-webkit-scrollbar {
          width: 8px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: #cbd5e1;
          border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: #94a3b8;
        }
      `}</style>

      {/* LEFT SIDEBAR - Navigation Tree */}
      <div style={{
        width: 280,
        minWidth: 280,
        backgroundColor: "#1e293b",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid #334155",
        overflow: "hidden",
      }}>
        {/* Sidebar Header */}
        <div style={{
          padding: "16px 14px 12px",
          borderBottom: "1px solid #334155",
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 4,
          }}>
            <FileText size={16} color="#6384a8" />
            <span style={{ color: "#e2e8f0", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              UFGS {sectionNumber}
            </span>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginLeft: 24 }}>
            {sectionTitle} ({ufgsDate})
          </div>
        </div>

        {/* Search */}
        <div style={{ padding: "8px 10px", borderBottom: "1px solid #334155" }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            backgroundColor: "#0f172a",
            borderRadius: 4,
            border: "1px solid #334155",
          }}>
            <Search size={13} color="#64748b" />
            <input
              placeholder="Search sections..."
              style={{
                background: "none",
                border: "none",
                outline: "none",
                color: "#cbd5e1",
                fontSize: 12,
                width: "100%",
              }}
            />
          </div>
        </div>

        {/* Tree */}
        <div style={{
          flex: 1,
          overflowY: "auto",
          padding: "6px 4px",
        }}>
          {tree.map(node => (
            <TreeNode
              key={node.id}
              node={node}
              selectedId={selectedTreeId}
              onSelect={handleTreeSelect}
              depth={0}
              numberMap={numberMap}
            />
          ))}
        </div>

        {/* Sidebar Footer */}
        <div style={{
          padding: "10px 14px",
          borderTop: "1px solid #334155",
          fontSize: 10,
          color: "#475569",
          letterSpacing: "0.04em",
        }}>
          UFGS SPEC EDITOR PROTOTYPE v0.1
        </div>
      </div>

      {/* RIGHT PANEL - Editor */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Toolbar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 16px",
          borderBottom: "1px solid #e2e8f0",
          backgroundColor: "#ffffff",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", fontFamily: "Georgia, serif" }}>
              SECTION {sectionNumber}
            </span>
            <span style={{ fontSize: 14, color: "#64748b" }}> - </span>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#334155", fontFamily: "Georgia, serif" }}>
              {sectionTitle}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#64748b" }}>
            <span style={{
              padding: "2px 8px",
              backgroundColor: "#ecfdf5",
              color: "#059669",
              borderRadius: 10,
              fontWeight: 600,
              fontSize: 11,
            }}>EDITING</span>
          </div>
        </div>

        {/* Mark Legend */}
        <MarkLegend />

        {/* Editor Content */}
        <div
          ref={editorRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 24px 100px",
            maxWidth: 800,
            marginLeft: "auto",
            marginRight: "auto",
            width: "100%",
          }}
        >
          {/* Section Banner */}
          <div style={{
            textAlign: "center",
            padding: "24px 0 16px",
            marginBottom: 16,
            borderBottom: "3px double #334155",
          }}>
            <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.1em", marginBottom: 4 }}>
              USACE / NAVFAC / AFCEC
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
              UFGS-{sectionNumber} ({ufgsDate})
            </div>
            <div style={{ fontSize: 10, color: "#94a3b8", letterSpacing: "0.08em", marginBottom: 8 }}>
              UNIFIED FACILITIES GUIDE SPECIFICATIONS
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", letterSpacing: "0.04em", fontFamily: "Georgia, serif" }}>
              SECTION {sectionNumber}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#1e293b", fontFamily: "Georgia, serif", marginTop: 4 }}>
              {sectionTitle}
            </div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>08/23</div>
          </div>

          {/* Content Blocks */}
          {blocks.map(block => {
            if (block.type === "title") {
              return (
                <TitleBlock
                  key={block.id}
                  block={block}
                  onFocus={handleClickFocus}
                  isFocused={focusedBlockId === block.id}
                  sectionNum={numberMap[block.id]}
                  onUpdate={handleBlockUpdate}
                  onPromote={handlePromote}
                  onDemote={handleDemote}
                  onEnterKey={handleEnterKey}
                  onDelete={handleDelete}
                  onFocusPrev={handleFocusPrev}
                  onFocusNext={handleFocusNext}
                />
              );
            }
            if (block.type === "table") {
              return (
                <TableBlock
                  key={block.id}
                  block={block}
                />
              );
            }
            return (
              <EditableBlock
                key={`${block.id}-${block.type}`}
                block={block}
                onUpdate={handleBlockUpdate}
                onEnterKey={handleEnterKey}
                onFocus={handleClickFocus}
                isFocused={focusedBlockId === block.id}
                oliLabel={block.type === "oli" ? oliLabels[block.id] : null}
                onDelete={handleDelete}
                onFocusPrev={handleFocusPrev}
                onFocusNext={handleFocusNext}
                onConvertBlock={handleConvertBlock}
              />
            );
          })}
        </div>

        {/* Status Bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 16px",
          borderTop: "1px solid #e2e8f0",
          backgroundColor: "#ffffff",
          fontSize: 11,
          color: "#94a3b8",
        }}>
          <span>{blocks.length} blocks | {blocks.filter(b => b.type === "title").length} sections | {blocks.filter(b => b.type === "table").length} tables</span>
          <span>Enter: new paragraph | Backspace: delete empty | / : insert block type | Tab/Shift+Tab: heading level</span>
          <span>SEC format</span>
        </div>
      </div>
    </div>
  );
}
