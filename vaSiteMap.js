'use strict';

/*
 * vaSiteMap.js
 * The route map a hosted VA website draws, as one file it serves.
 *
 * WHY IT IS NOT IN site.js
 * ------------------------
 * site.js is on every page of every site on the platform, and most of those
 * pages have no map on them. Most of this file is a projected coastline —
 * thirty-odd kilobytes of it — and charging every page of every site for a
 * picture that page does not show is the kind of cost nobody notices until the
 * whole platform is slow.
 *
 * So the route-map section writes its own <script src="map.js" defer> and the
 * file is fetched by the pages that actually draw a map. Everything else about
 * it is the same bargain site.js makes: no library, no basemap service, no key,
 * and nothing fetched from anybody.
 *
 * The drawing itself is documented in the script below, which is the copy a VA
 * can open in their own file editor.
 */

const MAP_JS = `/* map.js — your network, drawn.

   Loaded only by a page that has a route map on it: the section writes the
   script tag itself, so a site whose pages have no map never fetches this
   file. Nothing here is illustrated and nothing is decorative —

     THE COASTLINES are Natural Earth's public-domain 1:110m land, projected
     with Robinson and simplified to about a thousandth of the map's width.
     They are a single path in this file: no tiles, no basemap service, no
     request to anybody, and nothing to go down or start charging.

     THE AIRPORTS are the aerodrome reference points your crew centre holds
     for the sectors you publish. A sector whose airports we have no
     coordinates for is LEFT OFF rather than guessed at, and the count of
     those is said under the map rather than quietly hidden.

     THE ARCS are real great circles — interpolated over the sphere and
     projected point by point — so a sector to Tokyo bends over the pole
     because that is where the aeroplane goes, not because a curve looked
     nicer than a straight line.

   It reads CrewFeed.network(), which is the same route map your crew centre
   draws from. Publish a sector and it appears here; there is nothing to
   redraw and nothing to keep in step by hand. */
(function () {
  'use strict';

  if (!window.CrewFeed) return;

  /* The Robinson projection, as its published table of parallels. Five-degree
     steps from the equator to the pole, interpolated between. */
  var ROBINSON = [
    [1.0000, 0.0000], [0.9986, 0.0620], [0.9954, 0.1240], [0.9900, 0.1860],
    [0.9822, 0.2480], [0.9730, 0.3100], [0.9600, 0.3720], [0.9427, 0.4340],
    [0.9216, 0.4958], [0.8962, 0.5571], [0.8679, 0.6176], [0.8350, 0.6769],
    [0.7986, 0.7346], [0.7597, 0.7903], [0.7186, 0.8435], [0.6732, 0.8936],
    [0.6213, 0.9394], [0.5722, 0.9761], [0.5322, 1.0000]
  ];

  var W = 2000, H = 1014;
  var LAND = 'M839.1,974.2 850.5,983.4 828.6,987.1 814.9,985.6 822.9,981.5 826.6,974.2 839.1,974.2ZM730.0,939.5 732.9,945.7 725.2,947.4 706.8,943.1 716.6,940.7 712.0,932.0 715.9,928.6 730.0,939.5ZM750.5,902.9 737.7,906.5 737.0,910.3 741.2,914.1 735.3,915.8 731.7,923.6 757.8,940.2 767.4,950.7 767.7,955.5 742.6,967.6 718.8,968.0 736.9,973.6 723.7,975.7 735.0,982.8 809.3,995.3 832.9,989.7 857.1,991.0 902.0,984.5 896.3,979.8 875.9,980.8 873.1,975.6 894.8,967.8 934.6,960.6 940.9,957.5 938.5,952.2 959.6,941.1 971.0,943.3 972.9,939.4 999.1,943.0 1030.9,934.1 1042.7,938.9 1053.6,934.5 1107.5,937.0 1128.2,932.8 1137.5,926.6 1154.7,933.4 1228.1,912.1 1235.3,912.9 1241.8,920.0 1251.0,923.6 1263.3,920.7 1281.5,923.5 1278.7,932.9 1269.7,936.2 1273.4,938.1 1264.9,944.1 1271.0,946.2 1295.3,934.0 1311.9,931.8 1341.0,919.6 1357.6,919.3 1366.5,914.2 1369.7,919.3 1393.8,920.6 1410.6,919.8 1431.4,910.7 1438.8,918.1 1474.9,912.4 1478.9,916.9 1493.3,919.9 1511.7,915.7 1561.3,914.2 1568.2,909.3 1565.5,917.3 1567.9,918.2 1601.3,918.0 1599.5,923.3 1605.2,925.9 1626.1,926.9 1630.4,931.3 1638.4,932.5 1640.3,937.6 1660.9,938.9 1668.8,943.3 1600.0,965.8 1585.9,974.8 1591.2,975.5 1588.4,977.5 1566.2,979.4 1543.3,986.8 1543.7,992.2 1552.2,995.7 1549.4,997.5 1575.0,1000.8 1532.2,1014.0 467.8,1014.0 422.4,998.7 545.3,1002.0 500.8,997.0 489.4,990.9 468.1,987.4 491.0,988.3 497.3,984.5 455.5,978.9 425.0,968.8 454.9,971.2 466.0,966.9 456.4,961.8 459.7,961.0 464.7,962.6 489.5,956.5 549.2,957.4 566.5,953.5 578.4,958.6 625.3,961.5 599.8,948.0 633.0,953.0 655.4,951.5 655.3,947.7 711.0,954.8 735.3,949.9 738.9,945.1 725.5,933.1 721.9,917.8 733.1,905.7 748.6,898.6 754.8,899.4 750.5,902.9ZM682.9,843.3 697.5,848.4 696.7,851.4 689.1,849.6 685.6,853.8 670.8,850.5 647.7,837.2 667.7,844.6 672.0,835.3 682.9,843.3ZM1741.2,763.3 1755.6,763.8 1743.9,778.3 1733.1,780.4 1736.2,765.6 1741.2,763.3ZM1881.4,764.1 1880.5,766.7 1886.1,764.1 1885.5,766.8 1867.3,782.3 1857.3,784.7 1834.3,799.5 1823.5,796.9 1882.3,761.4 1881.4,764.1ZM1909.7,734.3 1909.2,740.9 1912.1,736.6 1911.0,743.1 1913.8,745.1 1923.7,743.9 1914.7,753.1 1888.9,768.9 1895.9,757.8 1892.0,755.3 1905.2,742.0 1905.7,724.1 1911.9,728.7 1909.7,734.3ZM1275.7,592.2 1276.8,605.7 1272.9,605.8 1257.6,656.5 1254.6,663.8 1245.1,668.0 1238.1,664.1 1235.3,650.2 1242.8,629.2 1240.9,616.5 1244.0,608.9 1254.4,606.2 1262.5,598.8 1271.4,582.7 1275.7,592.2ZM1790.7,593.5 1792.0,598.5 1795.8,596.1 1799.6,601.2 1800.1,626.2 1811.6,635.2 1813.2,647.5 1818.8,647.8 1818.1,654.5 1825.7,665.9 1825.4,670.9 1823.2,683.7 1813.8,701.4 1777.0,742.2 1752.5,752.3 1747.1,748.5 1749.7,745.2 1739.3,750.9 1726.6,746.0 1727.3,734.2 1721.4,730.9 1725.5,723.2 1715.8,728.7 1727.3,713.8 1712.5,726.3 1709.5,723.8 1709.4,712.1 1696.6,705.0 1667.4,709.5 1655.4,714.2 1650.3,720.1 1630.3,720.6 1617.9,727.4 1610.7,727.2 1604.2,722.0 1612.7,709.5 1614.4,692.2 1610.8,671.2 1612.5,673.9 1612.2,668.1 1615.3,672.3 1613.7,660.3 1620.8,643.8 1620.3,648.6 1636.0,637.1 1659.8,630.7 1675.1,610.1 1676.5,615.6 1679.0,614.3 1677.6,611.3 1691.9,596.5 1699.8,593.9 1706.1,600.5 1712.9,601.1 1720.3,585.8 1731.5,583.2 1728.0,577.9 1731.0,577.0 1746.4,584.0 1753.3,581.5 1755.4,584.7 1745.3,601.3 1767.9,618.3 1779.3,601.6 1781.5,585.0 1787.5,574.1 1790.7,593.5ZM1601.9,549.6 1612.5,550.2 1613.9,547.6 1640.5,559.6 1634.1,562.0 1583.9,550.1 1588.0,544.1 1601.9,549.6ZM1842.9,541.4 1832.8,546.7 1822.4,543.1 1832.9,538.4 1833.2,541.8 1836.4,541.3 1841.4,536.9 1840.9,533.2 1844.2,533.1 1842.9,541.4ZM1745.0,514.2 1746.2,524.4 1751.8,528.2 1756.7,521.5 1768.1,517.7 1802.4,531.3 1809.6,541.4 1818.5,545.2 1819.6,548.6 1814.5,549.3 1815.3,553.4 1832.8,573.5 1817.8,570.7 1808.7,557.7 1801.7,555.0 1793.3,558.8 1793.6,563.5 1789.1,565.6 1770.3,557.9 1761.8,559.9 1768.2,553.0 1765.0,540.9 1741.8,529.2 1737.9,532.9 1732.7,524.7 1742.3,520.9 1734.2,520.9 1724.9,512.9 1735.4,509.3 1745.0,514.2ZM1695.5,498.1 1687.1,505.5 1667.6,505.5 1666.8,510.3 1671.6,515.9 1685.1,510.9 1674.7,519.0 1683.1,540.6 1678.0,540.2 1680.9,535.1 1674.1,535.8 1671.6,523.5 1667.8,525.4 1667.9,541.8 1664.3,542.7 1663.2,529.0 1659.3,524.6 1666.8,503.4 1671.3,498.8 1682.8,501.5 1695.5,498.1ZM1586.7,543.8 1580.6,543.9 1569.2,533.5 1547.5,495.5 1528.5,472.5 1540.7,474.0 1558.8,493.8 1564.4,493.9 1576.9,506.3 1574.5,511.5 1589.0,526.2 1586.7,543.8ZM1654.5,495.5 1660.9,501.3 1654.4,502.1 1652.8,512.1 1647.3,516.4 1644.5,532.2 1643.8,530.0 1637.4,532.8 1628.7,526.6 1622.0,528.9 1620.1,525.8 1611.9,525.4 1611.2,517.0 1606.0,509.9 1605.7,498.6 1608.9,494.4 1617.3,495.4 1618.3,490.0 1627.2,487.5 1646.8,463.5 1661.0,473.0 1651.1,486.7 1654.5,495.5ZM1699.6,454.1 1701.0,461.8 1699.5,467.6 1697.1,461.1 1694.7,464.3 1695.4,471.9 1688.6,468.3 1688.2,460.7 1684.5,457.8 1675.4,461.8 1683.5,452.3 1685.6,455.2 1694.3,450.5 1693.6,445.6 1699.6,454.1ZM1450.2,468.0 1445.5,469.5 1442.6,464.5 1443.3,445.2 1453.0,459.7 1450.2,468.0ZM1663.6,390.7 1668.7,390.8 1671.6,399.5 1668.2,406.8 1670.0,416.9 1682.6,420.4 1684.3,428.2 1677.2,421.8 1676.0,424.1 1672.1,420.3 1664.3,419.9 1665.8,415.7 1660.4,412.9 1657.9,404.1 1660.5,406.2 1660.3,390.7 1663.6,390.7ZM603.9,382.1 618.1,383.5 626.4,390.0 624.1,392.5 613.4,391.2 608.9,396.4 604.0,392.5 592.6,391.7 604.5,389.6 599.2,383.5 603.9,382.1ZM567.5,363.9 574.5,365.5 594.6,380.9 575.6,382.2 579.7,378.7 574.2,376.6 571.7,371.2 555.4,367.5 555.9,364.7 538.0,369.3 553.8,361.2 567.5,363.9ZM1657.8,363.7 1656.4,368.9 1651.0,358.9 1656.2,348.0 1659.2,349.8 1657.8,363.7ZM1080.1,266.7 1078.5,276.8 1064.3,270.6 1064.9,267.4 1080.1,266.7ZM1731.2,273.5 1734.1,286.1 1719.7,289.4 1715.2,296.6 1708.5,289.5 1688.8,294.0 1696.0,298.6 1694.4,311.9 1682.0,297.7 1693.2,284.2 1708.9,283.7 1708.7,272.5 1713.7,275.5 1719.7,266.8 1713.6,248.2 1718.3,247.1 1726.6,255.7 1731.2,273.5ZM1719.9,229.7 1724.3,231.0 1726.1,228.4 1731.8,235.4 1725.4,237.1 1725.0,243.2 1714.3,239.0 1716.0,245.8 1710.4,245.9 1705.7,239.7 1705.2,234.9 1710.3,234.6 1704.4,221.2 1719.9,229.7ZM398.7,203.0 389.5,201.1 386.8,195.0 382.5,193.9 383.2,190.6 395.0,192.1 398.7,203.0ZM730.8,189.7 725.8,195.0 729.6,193.0 732.4,194.3 730.1,196.4 740.9,198.5 738.2,203.0 741.8,201.9 742.1,209.0 738.5,214.4 733.3,213.5 734.6,207.7 727.4,213.0 724.6,212.8 728.9,209.9 724.6,208.4 709.8,208.6 724.9,189.6 736.1,184.3 730.8,189.7ZM1688.7,189.4 1702.1,200.2 1693.5,198.1 1697.0,207.0 1709.4,217.6 1702.9,213.9 1703.1,218.6 1663.7,168.5 1688.7,189.4ZM967.8,180.3 952.6,182.9 956.8,176.7 954.7,170.5 968.8,162.8 973.6,166.5 967.8,180.3ZM986.5,142.5 981.5,148.9 991.1,148.1 985.7,158.1 990.4,158.5 1002.2,176.3 1007.9,177.4 1005.0,183.0 1006.9,186.1 974.7,194.1 972.2,192.9 983.7,185.3 975.0,181.9 980.0,180.0 978.5,172.9 985.5,173.4 986.2,169.9 977.5,165.1 976.7,159.2 974.2,162.0 971.9,153.4 977.5,142.6 986.5,142.5ZM643.1,102.8 642.2,105.1 657.5,113.5 652.6,115.3 646.0,111.4 631.8,117.3 632.5,114.0 626.4,114.6 643.1,102.8ZM939.7,98.5 938.3,102.0 942.6,105.6 920.0,114.8 902.9,112.2 907.5,109.7 898.8,106.9 906.6,104.3 898.0,103.0 908.0,98.7 913.8,102.4 939.7,98.5ZM274.0,97.8 289.7,96.0 290.5,101.0 275.3,104.0 264.4,110.5 256.7,106.8 259.2,104.4 250.4,104.2 254.9,100.3 240.1,106.4 272.9,84.9 279.3,94.4 274.0,97.8ZM636.4,82.1 632.2,87.6 640.8,83.3 643.0,86.8 638.8,90.8 640.1,94.5 658.1,80.0 672.4,83.9 664.3,94.9 644.1,97.9 585.5,129.5 575.9,140.7 581.8,141.7 579.6,151.6 586.7,150.4 606.7,162.0 618.8,162.9 613.9,174.2 618.2,186.6 628.4,178.5 628.7,165.8 649.7,154.8 650.9,146.0 647.9,141.6 656.4,135.4 661.3,121.5 680.2,120.8 686.8,128.1 694.4,128.6 689.7,140.7 695.0,145.0 714.4,132.7 720.1,152.3 716.7,156.0 733.3,166.1 733.3,171.1 737.8,174.2 735.9,181.0 711.1,192.4 680.4,192.5 650.1,213.4 677.3,199.2 684.8,198.6 688.1,201.6 682.1,205.7 681.5,217.0 695.4,219.1 702.5,212.2 704.0,218.9 671.9,233.6 668.2,233.1 669.6,227.9 679.8,222.8 666.0,223.7 648.3,232.7 642.0,241.1 645.0,245.5 622.9,251.0 614.6,262.3 612.4,258.8 612.9,265.6 606.2,273.1 607.6,261.0 605.8,267.6 602.8,266.7 605.6,268.7 604.4,283.5 568.5,309.3 566.4,318.2 569.4,338.0 565.7,348.5 561.5,348.6 559.3,344.4 556.6,324.1 551.6,317.8 545.6,320.7 539.9,315.9 524.9,316.4 522.4,317.3 523.3,322.9 518.0,323.9 499.1,320.2 478.9,332.0 468.4,365.9 474.0,385.5 483.2,392.9 504.1,385.8 508.3,375.0 526.4,371.6 511.6,407.1 533.3,406.4 541.4,411.0 537.1,437.2 545.1,450.4 552.0,451.3 559.8,446.6 574.7,452.7 581.4,447.6 586.3,437.3 594.6,436.4 604.2,428.8 607.5,430.8 602.7,435.2 603.3,450.0 607.1,445.0 605.6,438.0 612.6,435.5 614.1,430.5 623.1,440.6 634.0,440.1 641.2,443.6 644.6,440.1 658.1,439.6 653.3,441.5 655.0,444.5 663.5,448.0 664.2,453.1 672.7,456.7 683.2,469.4 700.8,470.8 715.2,480.6 719.5,495.0 722.5,496.1 718.4,505.6 729.9,508.5 730.2,514.8 734.3,510.7 750.6,516.8 752.5,523.9 758.9,522.0 778.1,525.1 793.5,537.3 804.6,541.4 807.6,553.2 805.6,563.6 786.8,589.1 785.0,619.3 777.4,644.9 772.2,651.4 757.9,653.8 742.4,663.4 738.5,669.7 738.3,687.3 717.6,723.2 705.4,726.2 692.8,720.2 704.7,735.9 701.9,747.0 679.1,751.0 683.0,762.6 668.6,765.0 671.1,771.2 679.7,774.3 672.7,780.1 673.6,789.7 666.1,792.8 666.3,797.4 677.8,803.2 678.0,808.7 668.5,824.5 677.3,834.3 665.9,837.6 665.7,843.3 644.8,833.7 632.3,812.0 635.5,801.3 627.3,799.6 629.9,794.1 627.9,783.9 634.2,786.1 632.6,773.2 628.6,771.5 629.7,779.3 626.2,778.4 623.9,753.7 618.3,740.6 622.3,710.8 617.5,688.4 618.5,641.5 615.0,622.3 581.8,599.1 558.1,552.2 549.6,545.6 548.3,536.8 557.2,523.7 550.5,521.1 550.5,513.6 555.1,502.2 562.1,498.3 572.0,482.8 567.2,454.7 559.7,450.8 554.4,456.1 556.9,459.6 551.9,461.6 551.1,457.9 537.7,453.9 530.1,443.6 529.2,446.9 526.3,444.6 526.6,437.3 516.7,425.8 517.9,423.4 497.6,419.4 480.2,405.1 469.5,408.6 433.7,392.0 424.3,381.6 425.7,367.0 410.3,346.2 411.5,340.8 399.8,325.0 399.1,311.0 396.1,308.5 391.8,307.1 388.8,317.4 399.3,339.4 401.1,354.2 406.8,360.1 403.7,363.5 393.3,351.5 394.6,343.5 382.6,332.7 388.8,327.4 383.2,321.2 381.3,299.2 377.1,293.1 367.4,289.4 363.5,262.2 364.2,253.7 385.2,221.3 391.7,205.0 398.8,205.9 397.7,211.7 403.8,200.0 389.4,188.9 394.4,179.9 390.4,177.3 393.5,165.0 390.5,160.9 395.0,145.5 383.9,145.0 376.8,137.3 352.9,129.6 321.7,139.5 340.1,127.3 271.4,158.0 232.0,167.4 284.7,148.8 296.4,140.9 272.7,142.3 279.4,136.7 271.9,135.7 270.0,131.7 279.6,122.8 292.3,116.8 312.9,113.3 320.0,107.5 299.8,109.4 295.3,108.1 295.6,102.7 317.7,97.8 321.1,97.8 316.8,100.5 325.9,100.3 324.9,89.9 321.7,88.2 356.3,77.7 385.6,72.4 389.2,75.8 427.9,78.6 448.2,85.3 491.6,76.9 495.0,82.1 504.3,78.5 500.4,82.6 513.9,80.4 537.0,88.0 528.6,90.7 550.9,90.2 552.3,93.5 561.5,86.6 570.4,85.8 574.0,90.0 584.1,92.0 597.0,91.3 603.7,87.0 608.5,88.8 604.4,93.9 619.8,84.4 615.3,78.9 629.1,69.6 635.4,72.6 635.5,78.4 629.8,81.0 636.4,82.1ZM562.2,63.5 557.6,65.9 577.6,64.3 577.1,71.0 584.2,63.7 591.3,63.7 593.4,65.8 588.2,74.3 597.0,79.2 587.5,82.0 585.2,86.1 573.0,83.8 540.1,87.2 540.3,84.7 532.1,83.8 531.3,79.6 553.3,77.5 532.5,76.6 544.1,72.7 532.7,71.4 545.5,65.6 562.2,63.5ZM668.2,63.3 668.5,66.5 687.0,60.3 689.3,65.5 686.0,68.9 700.1,65.4 710.3,70.4 709.2,72.6 717.3,71.4 729.3,78.7 730.2,83.7 721.3,86.2 734.7,91.0 737.9,95.9 744.2,96.3 730.2,106.3 722.6,98.8 716.9,99.5 714.6,102.6 722.6,109.8 722.6,115.4 719.1,119.5 706.0,113.4 712.0,123.7 693.8,118.1 690.1,115.4 692.5,113.8 683.1,108.1 669.4,110.7 667.0,108.7 672.3,104.6 689.4,103.9 701.3,91.6 689.2,85.3 692.7,83.9 685.4,78.5 674.5,80.7 646.1,75.5 652.3,73.2 646.7,73.1 657.1,63.4 673.8,60.0 668.2,63.3ZM618.8,59.8 629.7,60.2 623.3,64.2 627.1,66.3 622.0,70.9 610.3,72.5 603.8,66.6 612.7,65.6 611.8,62.3 618.8,59.8ZM641.0,65.3 629.0,68.9 637.4,59.7 656.3,59.8 641.0,65.3ZM527.6,72.2 514.2,74.8 509.1,69.9 528.2,60.7 528.4,57.5 555.5,58.1 559.1,61.7 527.6,72.2ZM1537.9,51.3 1541.0,54.9 1522.4,55.9 1506.8,49.5 1537.9,51.3ZM602.8,48.4 609.9,49.4 602.4,53.9 577.0,56.9 571.1,57.0 582.9,53.2 561.3,52.9 578.2,47.1 595.1,51.7 595.9,47.3 604.5,46.2 602.8,48.4ZM1227.6,75.7 1202.2,71.9 1200.2,69.1 1207.3,60.9 1203.5,60.3 1210.1,55.8 1207.8,53.6 1240.7,45.5 1251.4,46.8 1220.7,57.5 1214.6,67.3 1227.6,75.7ZM657.3,44.2 666.8,45.7 665.4,49.0 669.6,51.1 702.1,52.4 691.2,56.8 653.6,54.8 656.0,47.8 646.6,45.8 657.3,44.2ZM1387.9,44.8 1415.9,48.3 1423.8,52.4 1413.7,58.1 1473.4,64.3 1468.8,60.4 1484.1,61.2 1518.9,75.3 1515.7,70.0 1547.9,71.8 1538.5,67.1 1540.6,64.9 1580.2,68.2 1604.2,75.1 1627.8,74.9 1646.6,82.4 1673.2,81.6 1687.1,86.4 1689.6,84.7 1679.7,78.9 1717.9,82.6 1727.1,84.9 1759.9,106.5 1751.8,108.5 1777.3,121.5 1767.6,120.3 1758.2,125.2 1756.5,135.2 1745.2,131.3 1739.2,135.8 1726.4,135.3 1730.3,144.8 1739.8,148.5 1752.9,164.7 1747.8,167.8 1752.8,174.6 1747.2,176.1 1751.7,182.2 1750.2,187.8 1712.1,153.5 1709.5,147.2 1715.1,145.9 1718.1,128.1 1711.6,120.2 1706.9,120.6 1710.1,125.3 1706.6,131.5 1694.6,124.5 1685.6,126.5 1685.7,136.0 1693.2,139.6 1678.6,141.7 1674.5,137.5 1666.6,136.6 1664.1,139.4 1636.4,140.2 1628.2,165.4 1647.2,171.3 1647.7,168.3 1653.1,168.7 1665.6,175.3 1682.2,203.4 1682.5,216.5 1677.6,234.5 1673.1,238.2 1665.0,235.2 1658.3,243.6 1660.9,250.1 1653.7,257.2 1672.6,275.8 1675.8,286.4 1663.9,290.8 1655.4,276.1 1658.8,275.1 1644.1,267.5 1643.0,258.4 1636.4,256.1 1622.9,262.5 1624.0,253.0 1619.6,249.7 1611.5,260.3 1606.6,260.6 1605.2,263.5 1615.9,271.6 1620.9,273.4 1624.6,269.0 1636.1,274.9 1629.6,276.6 1624.2,287.5 1646.2,307.8 1647.9,312.4 1645.2,314.1 1651.5,319.4 1652.1,329.6 1649.3,330.1 1642.0,352.7 1629.1,363.8 1602.9,372.5 1602.3,379.1 1599.3,379.5 1597.9,372.5 1590.3,370.5 1578.0,382.8 1577.4,387.2 1598.6,411.0 1602.4,422.6 1602.8,433.7 1588.6,447.1 1582.0,452.9 1581.1,444.6 1571.9,440.2 1565.9,430.4 1556.0,427.6 1556.3,422.7 1551.5,422.7 1549.0,448.9 1552.6,449.1 1556.5,460.3 1573.6,476.5 1578.8,498.9 1574.9,499.3 1562.8,489.6 1554.7,466.4 1545.3,454.3 1544.6,458.0 1545.3,435.1 1532.8,400.6 1523.9,408.2 1517.2,406.2 1516.2,392.5 1496.2,363.9 1491.2,363.6 1490.9,369.7 1483.9,368.3 1473.3,371.9 1471.9,380.3 1464.5,384.5 1450.9,402.9 1441.2,407.0 1441.4,441.9 1429.4,456.9 1423.9,451.1 1403.8,406.5 1395.3,372.7 1383.9,375.7 1375.9,368.1 1376.4,363.4 1365.3,356.5 1358.4,347.2 1332.4,349.3 1309.7,345.2 1303.6,336.4 1294.6,340.5 1287.8,338.4 1276.4,331.8 1267.1,317.5 1260.7,316.4 1255.9,318.5 1261.9,332.9 1269.9,339.2 1274.8,351.4 1275.0,343.5 1278.3,344.8 1280.5,356.0 1292.4,355.4 1303.5,341.1 1307.7,354.6 1318.3,358.8 1324.9,366.7 1315.4,379.7 1315.3,387.9 1302.9,398.7 1287.5,404.0 1286.7,408.9 1268.0,419.0 1239.8,427.6 1233.9,401.5 1213.1,373.1 1208.6,358.1 1185.7,330.6 1186.5,321.5 1182.1,333.2 1173.0,319.3 1193.3,356.6 1192.7,361.8 1200.4,368.7 1205.0,390.0 1210.3,393.8 1215.6,406.9 1237.5,427.2 1238.9,431.7 1235.8,433.2 1246.6,441.4 1282.0,431.4 1282.1,440.1 1264.9,480.5 1223.5,523.2 1217.5,536.4 1215.0,547.7 1218.5,550.0 1216.9,560.3 1223.7,574.7 1224.3,599.4 1216.4,612.1 1204.9,617.6 1189.9,631.4 1193.3,645.9 1192.0,658.7 1175.7,668.7 1172.3,687.8 1149.0,713.0 1135.5,720.4 1118.7,719.9 1102.8,725.9 1096.6,721.6 1096.6,706.1 1081.8,677.3 1077.5,646.0 1064.6,620.6 1064.7,606.3 1075.2,582.7 1075.6,574.5 1066.1,538.7 1048.9,514.0 1054.4,487.7 1052.2,483.5 1047.2,477.0 1032.7,480.2 1024.0,467.6 1010.3,468.4 989.1,477.4 974.2,474.5 958.3,479.7 950.0,476.6 931.2,461.3 918.0,438.6 908.3,430.5 907.9,421.5 903.0,414.4 909.6,405.6 911.6,393.2 907.7,369.4 922.2,341.9 949.0,318.8 950.9,302.3 963.7,292.6 969.0,282.2 988.6,285.9 1007.6,276.9 1049.3,272.2 1052.9,276.2 1057.6,275.1 1054.4,294.6 1080.6,304.2 1083.4,309.7 1101.7,316.7 1106.6,312.2 1106.5,304.3 1113.7,300.5 1153.7,312.9 1164.3,308.6 1169.9,312.5 1179.5,312.3 1188.8,289.2 1188.0,276.6 1180.3,275.7 1177.2,279.3 1169.4,280.0 1164.8,276.7 1154.7,279.8 1143.7,276.6 1135.9,266.9 1137.9,262.0 1134.3,259.0 1139.4,253.0 1147.2,252.8 1148.7,248.0 1158.5,248.9 1169.7,243.1 1178.0,242.9 1195.3,249.7 1205.6,249.3 1211.2,243.4 1209.1,239.2 1182.3,223.0 1188.9,216.9 1185.6,214.5 1192.0,210.7 1172.7,216.7 1173.6,220.6 1181.3,221.7 1180.8,223.9 1169.3,228.5 1161.3,222.5 1164.7,217.9 1151.6,214.8 1147.5,224.3 1143.7,225.1 1139.7,239.6 1146.6,249.1 1140.6,249.4 1134.8,254.7 1132.8,250.5 1127.0,249.7 1121.0,251.4 1124.9,254.9 1122.4,255.9 1115.7,254.0 1124.4,270.3 1119.5,268.7 1120.5,278.0 1117.0,278.1 1099.2,254.1 1099.1,244.9 1065.1,220.0 1061.2,222.2 1063.0,230.2 1094.5,254.6 1093.7,256.8 1086.2,252.9 1084.3,256.9 1087.7,262.5 1083.2,268.3 1078.9,255.3 1061.4,245.0 1051.1,231.3 1044.4,228.5 1032.9,236.2 1015.6,236.5 1015.4,243.9 1004.1,249.3 1000.5,254.9 1000.6,263.5 996.5,270.4 988.8,276.5 977.3,276.4 972.0,281.0 966.1,274.8 953.8,275.3 954.4,266.5 950.9,263.5 955.3,250.9 952.7,236.8 960.0,232.3 990.4,234.4 994.1,218.3 985.5,208.8 978.1,206.4 977.7,201.9 992.1,202.2 990.7,195.2 995.2,197.9 1006.4,193.1 1007.8,188.2 1018.2,184.1 1022.2,175.3 1038.1,172.7 1041.1,169.7 1037.5,160.8 1038.9,151.5 1047.9,147.8 1046.8,152.8 1050.0,155.3 1044.6,161.1 1051.1,169.8 1058.3,167.0 1066.1,171.3 1081.8,164.7 1091.6,167.3 1098.5,162.7 1098.0,149.7 1102.0,147.7 1109.9,152.0 1110.0,144.0 1104.3,139.3 1124.7,137.6 1129.2,134.4 1123.9,131.7 1101.6,135.5 1093.9,130.5 1092.6,116.5 1107.1,105.7 1099.8,100.9 1092.9,102.4 1090.7,109.6 1077.1,119.0 1075.0,127.0 1083.3,134.1 1080.0,140.7 1075.5,142.0 1073.0,157.4 1067.3,156.8 1065.2,161.4 1059.9,161.7 1046.2,137.7 1037.8,144.4 1025.5,142.8 1021.7,123.4 1044.7,109.2 1060.4,91.2 1076.7,80.3 1110.8,73.3 1124.2,77.0 1119.5,78.4 1124.8,81.7 1128.4,79.9 1164.7,90.5 1170.2,96.7 1166.6,99.5 1137.6,97.5 1145.5,101.5 1148.4,109.6 1158.1,112.8 1154.5,107.6 1156.7,105.5 1167.9,109.0 1171.1,107.6 1166.9,103.6 1174.8,98.4 1183.3,100.6 1184.4,96.8 1176.3,87.1 1188.3,88.8 1191.9,91.8 1186.9,92.5 1188.1,95.5 1192.1,97.3 1217.3,85.5 1220.4,85.8 1217.9,89.0 1237.8,85.4 1244.0,88.6 1246.8,85.1 1242.1,80.2 1279.5,89.6 1280.6,86.8 1268.9,82.3 1262.8,74.1 1268.5,63.9 1282.5,68.1 1281.7,72.2 1299.5,87.9 1296.5,99.2 1301.8,100.0 1307.3,91.4 1295.1,81.4 1294.6,76.1 1286.5,72.0 1291.0,68.6 1287.4,65.0 1300.4,73.5 1295.8,69.8 1308.7,67.6 1318.2,70.5 1306.6,60.8 1329.4,59.3 1324.0,56.7 1325.4,53.4 1368.5,47.3 1368.0,43.3 1374.0,41.4 1387.9,44.8ZM1249.7,247.7 1257.6,254.0 1253.5,254.5 1251.5,263.1 1254.7,270.8 1264.0,275.2 1279.4,274.6 1277.2,262.2 1269.7,255.4 1269.6,250.2 1278.8,249.7 1271.8,242.4 1268.1,244.0 1268.7,248.6 1264.7,238.3 1258.3,236.2 1251.0,227.0 1256.0,227.6 1255.1,223.0 1263.7,223.0 1261.0,213.2 1251.6,212.0 1242.3,216.0 1232.9,227.0 1249.7,247.7ZM1063.3,32.1 1075.7,35.6 1067.3,37.4 1062.2,45.5 1057.9,45.7 1036.3,32.3 1063.3,32.1ZM1351.4,35.9 1333.0,35.2 1313.0,29.5 1324.6,26.1 1347.1,31.7 1351.4,35.9ZM697.9,32.3 700.5,33.8 677.2,39.0 668.9,36.5 675.2,33.6 666.7,32.1 687.4,26.0 698.4,29.5 697.9,32.3ZM775.2,19.2 795.4,20.9 731.5,33.9 735.8,34.5 711.3,44.7 716.7,45.7 704.2,48.5 672.9,47.1 684.7,40.5 694.6,42.2 688.1,38.3 703.1,33.8 701.1,29.8 719.6,29.0 700.1,28.8 693.3,23.7 775.2,19.2ZM911.7,17.6 931.1,20.6 893.7,22.5 925.9,24.3 921.5,26.4 947.2,23.6 958.7,25.9 931.0,30.1 938.9,30.2 930.6,36.5 929.4,41.7 933.0,44.7 921.0,46.4 927.1,48.8 927.0,52.8 922.9,53.2 926.9,57.5 918.4,57.9 922.4,60.0 920.7,61.7 909.9,62.5 913.4,68.3 903.9,67.5 913.3,71.9 913.9,76.0 906.6,77.0 899.9,72.1 900.3,75.5 895.1,78.2 910.9,78.7 832.8,103.8 815.0,119.4 815.3,123.8 807.7,134.0 787.7,129.7 779.0,114.1 777.6,94.5 796.7,79.7 780.7,81.4 785.2,75.2 796.3,76.5 781.8,70.9 788.7,66.2 782.6,51.5 748.0,49.0 741.2,44.6 759.5,42.9 738.7,39.8 770.9,33.5 773.6,31.8 765.6,30.3 789.8,24.1 832.8,21.6 850.4,24.5 843.7,22.5 874.2,17.5 911.7,17.6Z';

  function project(lat, lon) {
    var a = Math.min(Math.abs(lat), 89.999);
    var i = Math.min(Math.floor(a / 5), 17);
    var t = (a - i * 5) / 5;
    var xr = ROBINSON[i][0] + (ROBINSON[i + 1][0] - ROBINSON[i][0]) * t;
    var yr = ROBINSON[i][1] + (ROBINSON[i + 1][1] - ROBINSON[i][1]) * t;
    if (lat < 0) yr = -yr;
    return [0.5 + (lon / 180) * xr * 0.5, 0.5 - yr * 0.5];
  }

  /* The shortest path over the sphere between two points, sampled. Spherical
     linear interpolation on the unit vectors — which is the path the aeroplane
     actually flies, and the reason a long sector is drawn as a curve. */
  function greatCircle(a, b, steps) {
    var rad = Math.PI / 180;
    var v = function (p) {
      var la = p[0] * rad, lo = p[1] * rad;
      return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    };
    var p = v(a), q = v(b);
    var dot = Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
    var d = Math.acos(dot);
    if (d < 1e-9) return [a, b];
    var out = [];
    for (var i = 0; i <= steps; i++) {
      var f = i / steps;
      var s1 = Math.sin((1 - f) * d) / Math.sin(d);
      var s2 = Math.sin(f * d) / Math.sin(d);
      var x = s1 * p[0] + s2 * q[0], y = s1 * p[1] + s2 * q[1], z = s1 * p[2] + s2 * q[2];
      out.push([Math.atan2(z, Math.hypot(x, y)) / rad, Math.atan2(y, x) / rad]);
    }
    return out;
  }

  /* A sampled great circle, as one or more SVG paths.

     CUT AT THE ANTIMERIDIAN. Los Angeles to Sydney crosses 180 degrees, and
     drawn as one polyline it runs back across the entire map as a horizontal
     scar. The line is broken where the longitude wraps and continues on the
     far edge, which is what an atlas does with the same sector. */
  function arcPaths(pts) {
    var runs = [[]], prev = null;
    pts.forEach(function (pt) {
      if (prev !== null && Math.abs(pt[1] - prev) > 180) runs.push([]);
      prev = pt[1];
      var xy = project(pt[0], pt[1]);
      runs[runs.length - 1].push((xy[0] * W).toFixed(1) + ',' + (xy[1] * H).toFixed(1));
    });
    return runs.filter(function (r) { return r.length > 1; })
      .map(function (r) { return 'M' + r.join(' '); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* -------------------------------------------------------------------------
     DRAW.

     'host' is the element to fill and 'net' is CrewFeed.network(): the sectors
     with both ends already joined to their aerodrome reference points, and the
     airports themselves with how many sectors touch each.
     --------------------------------------------------------------------- */
  function draw(host, net) {
    var pos = {};
    Object.keys(net.airports || {}).forEach(function (icao) {
      var a = net.airports[icao];
      pos[icao] = [a.lat, a.lon];
    });
    // A leg carries its own two points as well. Used where the airport list
    // did not mention one of its ends, so a sector is never dropped for a gap
    // in a list it did not come from.
    net.routes.forEach(function (r) {
      if (!pos[r.from] && r.fromLatLon) pos[r.from] = r.fromLatLon;
      if (!pos[r.to] && r.toLatLon) pos[r.to] = r.toLatLon;
    });

    var legs = net.routes.filter(function (r) { return pos[r.from] && pos[r.to]; });
    if (!legs.length) return 0;

    // The busiest airports, which is what a base IS. Worked out from the
    // network rather than typed anywhere, so it cannot go stale.
    var touches = {};
    legs.forEach(function (r) {
      touches[r.from] = (touches[r.from] || 0) + 1;
      touches[r.to] = (touches[r.to] || 0) + 1;
    });
    var ranked = Object.keys(touches).sort(function (a, b) { return touches[b] - touches[a]; });
    var hubs = {};
    ranked.slice(0, Math.min(4, Math.max(1, Math.round(ranked.length / 6)))).forEach(function (i) { hubs[i] = 1; });

    // The shell goes in first so the map's height can be MEASURED rather than
    // assumed: the label type is sized in screen pixels, and there is no fixed
    // font size that works at every crop. Reusing it on a redraw also keeps
    // the reader's pan position.
    var shell = host.querySelector('.netmap__scroll');
    if (!shell) {
      host.innerHTML = '<div class="netmap__scroll" tabindex="0" role="region"'
        + ' aria-label="Route map — drag or scroll sideways to pan"><svg class="netmap__svg"></svg></div>';
      shell = host.querySelector('.netmap__scroll');
    }
    var svg = shell.querySelector('.netmap__svg');
    var mapPx = Math.max(160, svg.clientHeight || shell.clientHeight || 320);

    /* CROP TO THE NETWORK, NOT TO THE WORLD.
       A full world map is Antarctica across the bottom and empty ocean down
       both sides; on a phone that leaves the airline about a hundred pixels
       tall. The box is the bounding box of everything actually drawn, padded —
       and the arcs are SAMPLED for it rather than just their endpoints,
       because the great circle to Tokyo climbs far north of either end. */
    var pts = [];
    legs.forEach(function (r) {
      greatCircle(pos[r.from], pos[r.to], 24).forEach(function (q) { pts.push(project(q[0], q[1])); });
    });
    var xs = pts.map(function (q) { return q[0]; });
    var ys = pts.map(function (q) { return q[1]; });
    var padX = 0.055, padY = 0.05;
    var x0 = Math.max(0, Math.min.apply(null, xs) - padX);
    var x1 = Math.min(1, Math.max.apply(null, xs) + padX);
    var y0 = Math.max(0, Math.min.apply(null, ys) - padY);
    var y1 = Math.min(1, Math.max.apply(null, ys) + padY);
    var box = [x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H];

    var arcs = legs.map(function (r) {
      var cls = 'netmap__arc' + (r.codeshare ? ' is-share' : '');
      return arcPaths(greatCircle(pos[r.from], pos[r.to], 64)).map(function (d) {
        return '<path class="' + cls + '" d="' + d + '"/>';
      }).join('');
    }).join('');

    // One dot per airport, never one per sector: two sectors into the same
    // field are one place on a map.
    var places = Object.keys(pos).filter(function (i) { return touches[i]; });
    places.sort(function (a, b) { return (hubs[b] ? 1 : 0) - (hubs[a] ? 1 : 0); });

    /* LABELS, PLACED RATHER THAN PRINTED.
       Airports a few degrees apart put their labels on top of each other and
       on the arcs leaving them. Each is tried in turn around its dot and takes
       the first spot that collides with nothing already placed; one that finds
       none is left unlabelled rather than overprinted. This is what a
       cartographer does by hand, and it is the difference between four bases
       and one smudge. */
    var perPx = box[3] / mapPx;
    var small = (host.clientWidth || 900) < 560;
    var FONT = (small ? 12.5 : 13.5) * perPx;
    var CH = FONT * 0.56, LH = FONT * 1.5, OFF = 9 * perPx;
    var R_HUB = 6.5 * perPx, R_DOT = 4 * perPx;
    var boxes = [];
    var hits = function (r) {
      return boxes.some(function (b) {
        return r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y;
      });
    };
    var SPOTS = [[1, 0.3], [-1, 0.3], [1, -1], [-1, -1], [1, 1.6], [-1, 1.6],
                 [1, -2.3], [-1, -2.3], [1, 2.9], [-1, 2.9]]
      .map(function (p) { return [p[0] * (OFF + FONT * 0.35), p[1] * LH]; });

    function place(px, py, label) {
      var w = label.length * CH;
      for (var i = 0; i < SPOTS.length; i++) {
        var dx = SPOTS[i][0], dy = SPOTS[i][1];
        var x = px + dx;
        var b = { x: dx > 0 ? x : x - w, y: py + dy - LH * 0.72, w: w, h: LH };
        if (hits(b)) continue;
        boxes.push(b);
        return { x: x, y: py + dy, anchor: dx > 0 ? 'start' : 'end' };
      }
      return null;
    }

    // Every dot is an obstacle, named or not, so a label never lands on one.
    places.forEach(function (icao) {
      var xy = project(pos[icao][0], pos[icao][1]);
      var r = (hubs[icao] ? R_HUB : R_DOT) + 2 * perPx;
      boxes.push({ x: xy[0] * W - r, y: xy[1] * H - r, w: r * 2, h: r * 2 });
    });

    var dots = places.map(function (icao) {
      var xy = project(pos[icao][0], pos[icao][1]);
      var px = xy[0] * W, py = xy[1] * H;
      var isHub = !!hubs[icao];
      var n = touches[icao];
      var title = icao + ' — ' + n + (n === 1 ? ' sector' : ' sectors') + (isHub ? ' · a base' : '');
      var spot = (isHub || !small) ? place(px, py, icao) : null;
      return '<g class="netmap__pt' + (isHub ? ' is-hub' : '') + '" role="listitem" aria-label="' + esc(title) + '">'
        + '<title>' + esc(title) + '</title>'
        + '<circle class="netmap__halo" cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="' + (R_HUB * (isHub ? 1.9 : 1.5)).toFixed(1) + '"/>'
        + '<circle class="netmap__dot" cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="' + (isHub ? R_HUB : R_DOT).toFixed(1) + '"/>'
        + (spot ? '<text class="netmap__label" x="' + spot.x.toFixed(1) + '" y="' + spot.y.toFixed(1) + '"'
            + ' text-anchor="' + spot.anchor + '" font-size="' + FONT.toFixed(1) + '"'
            + ' stroke-width="' + (FONT * 0.22).toFixed(1) + '">' + esc(icao) + '</text>' : '')
        + '</g>';
    }).join('');

    // The labels were placed after the crop was chosen, and a name set beside a
    // dot near the edge lands outside it. Grow the crop to contain what was
    // actually drawn rather than clipping the airline's own bases off it.
    if (boxes.length) {
      var bx0 = box[0], by0 = box[1], bx1 = box[0] + box[2], by1 = box[1] + box[3];
      boxes.forEach(function (b) {
        bx0 = Math.min(bx0, b.x - OFF); by0 = Math.min(by0, b.y - OFF);
        bx1 = Math.max(bx1, b.x + b.w + OFF); by1 = Math.max(by1, b.y + b.h + OFF);
      });
      box = [bx0, by0, bx1 - bx0, by1 - by0];
    }

    svg.setAttribute('viewBox', box.map(function (v) { return v.toFixed(0); }).join(' '));
    svg.setAttribute('role', 'list');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('aria-label', 'Route map: ' + legs.length + (legs.length === 1 ? ' sector' : ' sectors'));
    svg.innerHTML = '<path class="netmap__land" d="' + LAND + '"/>'
      + '<g class="netmap__arcs">' + arcs + '</g>'
      + '<g class="netmap__pts">' + dots + '</g>';

    wirePan(shell);
    return legs.length;
  }

  /* The map can be wider than the page, so it is pannable — by the scrollbar,
     by a swipe, and by dragging, because on a desktop there is no other
     obvious way to move a picture that has no handle on it. */
  function wirePan(scroller) {
    var settle = function () {
      var slack = scroller.scrollWidth - scroller.clientWidth;
      // Only ADVERTISE panning when there is enough of it to be worth saying.
      // "Drag to pan" under a map that moves thirty pixels is an instruction
      // to do nothing.
      scroller.classList.toggle('has-pan', slack > 64);
      if (slack > 4) scroller.scrollLeft = slack / 2;
    };
    if (window.requestAnimationFrame) requestAnimationFrame(settle); else settle();

    if (scroller.__pan) return;
    scroller.__pan = true;
    var down = false, startX = 0, startLeft = 0;
    scroller.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return;      // native scrolling is better
      down = true; startX = e.clientX; startLeft = scroller.scrollLeft;
      scroller.classList.add('is-dragging');
    });
    scroller.addEventListener('pointermove', function (e) {
      if (down) scroller.scrollLeft = startLeft - (e.clientX - startX);
    });
    var release = function () { down = false; scroller.classList.remove('is-dragging'); };
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
      scroller.addEventListener(t, release);
    });
  }

  /* -------------------------------------------------------------------------
     MOUNT.

     A map that never got a network takes its section with it where the section
     asked to be removed when empty — the same contract every other live block
     on the page keeps. A heading over an empty rectangle reads as a fault in
     the site rather than as an airline that has not published its network yet.
     --------------------------------------------------------------------- */
  var mounted = [];

  function boot() {
    var hosts = Array.prototype.slice.call(document.querySelectorAll('[data-crew-map]'));
    if (!hosts.length) return;
    CrewFeed.network().then(function (net) {
      hosts.forEach(function (host) {
        var drawn = (net && net.routes && net.routes.length) ? draw(host, net) : 0;
        if (!drawn) {
          var section = host.closest ? host.closest('[data-crew-section]') : null;
          if (section) section.remove(); else host.remove();
          return;
        }
        mounted.push({ host: host, net: net });
        var said = host.parentNode && host.parentNode.querySelector('[data-crew-map-note]');
        if (said) {
          // What is on the map, and what could not be put on it. Said rather
          // than hidden: an airline whose website silently draws a smaller
          // network than the one listed under it looks like it lost routes.
          var note = drawn + (drawn === 1 ? ' sector' : ' sectors');
          if (net.unmapped) note += ' · ' + net.unmapped + ' we have no coordinates for yet';
          said.textContent = note;
        }
      });
    }).catch(function () { /* the page keeps whatever it already said */ });
  }

  /* Label sizing is computed from how wide the host actually IS, so a map
     drawn at one width and resized to another is drawn at the wrong type size —
     a phone turned landscape, a window dragged narrow. Redraw once the resize
     has settled. */
  var timer = null;
  window.addEventListener('resize', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      mounted.forEach(function (m) { if (m.host.isConnected) draw(m.host, m.net); });
    }, 180);
  }, { passive: true });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;

module.exports = { MAP_JS };
